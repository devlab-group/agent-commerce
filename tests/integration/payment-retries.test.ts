/**
 * Exercise retries over HTTP, MCP and A2A through the gateway, the x402 and MPP
 * providers, and SQLite. An injected backend controls delivery; a mocked x402
 * facilitator client counts verification and settlement calls without
 * contacting a chain.
 */
import { Challenge } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../src/config';
import {
  type BackendExecutor,
  type BackendRequest,
  type BackendResponse,
  type Clock,
  type CommerceResource,
  DELIVERY_SUMMARY_META_KEY,
  PAYMENT_HEADER,
  PAYMENT_INPUT_FIELD,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createMppPaymentProvider } from '../../src/payments/mpp/provider';
import { createPaymentProof } from '../../src/payments/x402/client';
import { createX402PaymentProvider } from '../../src/payments/x402/provider';
import { createA2aAdapter } from '../../src/protocols/a2a';
import type { A2aTask } from '../../src/protocols/a2a/types';
import { A2A_X402_EXTENSION_URI } from '../../src/protocols/a2a/x402-extension';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createSqliteReceiptStore } from '../../src/storage/receipts';

process.env['NODE_ENV'] = 'test';

interface SignedPayload {
  readonly payload: { readonly authorization: { readonly from: string } };
}

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('@x402/core/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@x402/core/http')>()),
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitator.verify(...args);
    }
    settle(...args: unknown[]) {
      return facilitator.settle(...args);
    }
  },
}));

const TX = `0x${'cd'.repeat(32)}`;
const ASSET = '0x1111111111111111111111111111111111111111' as const;
const AUTHORIZATION = { name: 'MockUSDC', version: '2' };
const PAY_TO = privateKeyToAccount(generatePrivateKey()).address;
const BUYER_KEY = generatePrivateKey();
const buyer = privateKeyToAccount(BUYER_KEY);
const otherBuyer = privateKeyToAccount(generatePrivateKey());
const REMOTE = {
  mode: 'remote',
  url: 'https://facilitator.example.com',
  auth: { type: 'none' },
} as const;
const RPC_URL = 'http://127.0.0.1:19321'; // never contacted: the facilitator client is mocked

const ID = 'purchase-0123456789abcdef';
const KEY = 'order-42-retry';
const REPORT = { report: 'paid' };
const OK: BackendResponse = { status: 200, body: REPORT, headers: {}, durationMs: 1 };

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

function resource(
  id: string,
  paymentMethods: CommerceResource['paymentMethods'],
  idempotency?: CommerceResource['idempotency'],
): CommerceResource {
  return {
    id,
    name: id,
    description: 'A paid report.',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      additionalProperties: false,
    },
    handler: { type: 'http', method: 'POST', url: 'http://backend.local/report' },
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    exposedVia: ['http', 'mcp', 'a2a'],
    paymentMethods,
    ...(idempotency !== undefined ? { idempotency } : {}),
  };
}

const OPTIONAL = { redelivery: { retentionHours: 24, required: false } };
const RESOURCES = [
  resource('x402_report', ['x402'], OPTIONAL),
  resource('x402_required', ['x402'], { redelivery: { retentionHours: 24, required: true } }),
  resource('mpp_report', ['mpp'], OPTIONAL),
  resource('mpp_plain', ['mpp']),
];

// Tests initialize MPP's expiry clock at setup and advance it explicitly
let mppNowMs = 0;
const mppClock: Clock = {
  now: () => new Date(mppNowMs),
  nowIso: () => new Date(mppNowMs).toISOString(),
  monotonicMs: () => mppNowMs,
};

let backendResponse: BackendResponse = OK;
let backendFails = false;
let hold: Promise<void> | undefined;
let backendCalls: BackendRequest[] = [];
const backend: BackendExecutor = {
  async call(_handler, request) {
    backendCalls.push(request);
    await hold;
    if (backendFails) throw new Error('merchant down');
    return backendResponse;
  },
};

let gateways: GatewayInstance[] = [];
let gateway: GatewayInstance;

beforeEach(async () => {
  mppNowMs = Date.now();
  backendResponse = OK;
  backendFails = false;
  hold = undefined;
  backendCalls = [];
  const payerOf = (payload: SignedPayload) => payload.payload.authorization.from;
  facilitator.verify.mockReset().mockImplementation(async (payload: SignedPayload) => ({
    isValid: true,
    payer: payerOf(payload),
  }));
  facilitator.settle.mockReset().mockImplementation(async (payload: SignedPayload) => ({
    success: true,
    transaction: TX,
    network: 'eip155:31337',
    payer: payerOf(payload),
  }));
  gateway = await startGateway(RESOURCES);
});

afterEach(async () => {
  await Promise.all(gateways.map((instance) => instance.close().catch(() => {})));
  gateways = [];
});

function config(resources: readonly CommerceResource[]): GatewayConfig {
  return {
    version: 1,
    merchant: { id: 'shop', name: 'Shop', publicBaseUrl: 'https://gw.example' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
      a2a: { enabled: true, mountPath: '/a2a' },
      acp: { enabled: false, mountPath: '/acp' },
    },
    resources: [...resources],
    payments: {},
  };
}

async function startGateway(resources: readonly CommerceResource[]): Promise<GatewayInstance> {
  const instance = await createGateway({
    config: config(resources),
    store: createSqliteReceiptStore({ path: ':memory:' }),
    paymentProviders: [
      createX402PaymentProvider({
        network: 'eip155:31337',
        rpcUrl: RPC_URL,
        asset: ASSET,
        assetName: AUTHORIZATION.name,
        assetVersion: AUTHORIZATION.version,
        assetDecimals: 6,
        payTo: PAY_TO,
        facilitator: REMOTE,
      }),
      createMppPaymentProvider({
        network: 'eip155:31337',
        recipient: PAY_TO,
        asset: ASSET,
        assetName: AUTHORIZATION.name,
        assetVersion: AUTHORIZATION.version,
        realm: 'gateway.test',
        challengeSecret: 's'.repeat(32),
        rpcUrl: RPC_URL,
        facilitator: REMOTE,
        clock: mppClock,
      }),
    ],
    protocolAdapters: [createMcpAdapter(), createA2aAdapter()],
    backend,
  });
  gateways.push(instance);
  return instance;
}

function invoke(
  resourceId: string,
  headers: Record<string, string> = {},
  body = '{}',
  instance: GatewayInstance = gateway,
) {
  return instance.server.inject({
    method: 'POST',
    url: `/api/resources/${resourceId}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

function decodeHeader(value: unknown): Record<string, unknown> {
  return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
}

// Sign a fresh x402 challenge from the HTTP route
async function x402Proof(resourceId: string, id?: string, body = '{}'): Promise<string> {
  return signX402(
    decodeHeader((await invoke(resourceId, {}, body)).headers[PAYMENT_REQUIRED_HEADER]),
    id,
  );
}

// Sign an x402 challenge, echoing its declaration with `id` when supplied
function signX402(required: Record<string, unknown>, id?: string): Promise<string> {
  const accepts = (required['accepts'] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const declared = (required['extensions'] as Record<string, { info: object }>)[
    'payment-identifier'
  ] as { info: object };
  return createPaymentProof({
    buyerPrivateKey: BUYER_KEY,
    accepts,
    ...(id !== undefined
      ? { extensions: { 'payment-identifier': { ...declared, info: { ...declared.info, id } } } }
      : {}),
  });
}

// Answer a fresh MPP challenge from the HTTP route
async function mppCredential(
  resourceId: string,
  account: PrivateKeyAccount = buyer,
  instance: GatewayInstance = gateway,
): Promise<string> {
  const challenged = await invoke(resourceId, {}, '{}', instance);
  return signMpp(challenged.headers['www-authenticate'], account);
}

async function signMpp(
  wwwAuthenticate: unknown,
  account: PrivateKeyAccount = buyer,
): Promise<string> {
  const challenge = Challenge.deserialize(String(wwwAuthenticate)) as unknown as EvmChallenge;
  const client = clientCharge({ account, authorization: AUTHORIZATION });
  return String(await client.createCredential({ challenge, context: {} }));
}

// Hold the backend until the returned function runs
function holdBackend(): () => void {
  let release = () => {};
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

// One MCP tools/call; Streamable HTTP may frame the reply as an SSE event
async function callMcp(
  resourceId: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ToolResult> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: resourceId, arguments: args },
    },
  });
  const raw = res.body.startsWith('event:')
    ? (res.body.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)
    : res.body;
  return (JSON.parse(raw) as { result: ToolResult }).result;
}

interface A2aReply {
  readonly result?: { readonly task: A2aTask };
  readonly error?: { readonly code: number; readonly message: string };
}

async function sendA2a(
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<A2aReply> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: { message },
    }),
  });
  return res.json<A2aReply>();
}

const EXTENSION = { 'a2a-extensions': A2A_X402_EXTENSION_URI };

function buyMessage(resourceId: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'ROLE_USER',
    messageId: 'msg-buy',
    parts: [{ data: { resource: resourceId, input }, mediaType: 'application/json' }],
  };
}

function payMessage(task: A2aTask, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'ROLE_USER',
    messageId: 'msg-pay',
    taskId: task.id,
    contextId: task.contextId,
    parts: [{ text: 'Here is the payment.' }],
    metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': payload },
  };
}

// A new A2A task carrying the proof in `_payment`, without the extension
async function a2aPayment(
  resourceId: string,
  proof: string,
  input: Record<string, unknown> = {},
): Promise<A2aTask> {
  const { result } = await sendA2a(
    buyMessage(resourceId, { ...input, [PAYMENT_INPUT_FIELD]: proof }),
  );
  return result?.task as A2aTask;
}

// A new A2A task waiting for an x402 extension payment
async function a2aChallenge(
  resourceId: string,
  input: Record<string, unknown> = {},
): Promise<A2aTask> {
  const task = (await sendA2a(buyMessage(resourceId, input), EXTENSION)).result?.task as A2aTask;
  expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  return task;
}

function challengeOf(task: A2aTask): Record<string, unknown> {
  return task.status.message?.metadata?.['x402.payment.required'] as Record<string, unknown>;
}

async function a2aPay(task: A2aTask, proof: string): Promise<A2aReply> {
  return sendA2a(payMessage(task, decodeHeader(proof)), EXTENSION);
}

function artifactData(task: A2aTask): Record<string, unknown> | undefined {
  return task.artifacts[0]?.parts[0]?.data;
}

function summaryOf(task: A2aTask): unknown {
  return task.artifacts[0]?.metadata?.[DELIVERY_SUMMARY_META_KEY];
}

describe('x402 retries over HTTP', () => {
  it('redelivers an exact resend, marked as a replay, without a second charge', async () => {
    const proof = await x402Proof('x402_report', ID);

    const first = await invoke('x402_report', { [PAYMENT_HEADER]: proof });
    const resend = await invoke('x402_report', { [PAYMENT_HEADER]: proof });

    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toEqual(REPORT);
    expect(resend.headers['idempotent-replayed']).toBe('true');
    expect(resend.headers['cache-control']).toBe('private');
    expect(resend.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(decodeHeader(resend.headers[PAYMENT_RESPONSE_HEADER])).toEqual(
      decodeHeader(first.headers[PAYMENT_RESPONSE_HEADER]),
    );
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(backendCalls).toHaveLength(1);
  });

  it('redelivers to a fresh proof from the same payer after verifying it', async () => {
    const first = await invoke('x402_report', {
      [PAYMENT_HEADER]: await x402Proof('x402_report', ID),
    });

    const retry = await invoke('x402_report', {
      [PAYMENT_HEADER]: await x402Proof('x402_report', ID),
    });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(REPORT);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('redelivers a text body with its type and sandbox policy, and no Set-Cookie', async () => {
    backendResponse = {
      status: 200,
      body: '<p>report</p>',
      headers: { 'content-type': 'text/html', 'set-cookie': 'session=secret' },
      durationMs: 1,
    };
    const proof = await x402Proof('x402_report', ID);
    await invoke('x402_report', { [PAYMENT_HEADER]: proof });

    const resend = await invoke('x402_report', { [PAYMENT_HEADER]: proof });

    expect(resend.statusCode).toBe(200);
    expect(resend.body).toBe('<p>report</p>');
    expect(resend.headers['idempotent-replayed']).toBe('true');
    expect(resend.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(resend.headers['content-security-policy']).toBe('sandbox');
    expect(resend.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a payment without an id when the resource requires one', async () => {
    const proof = await x402Proof('x402_required');

    const refused = await invoke('x402_required', { [PAYMENT_HEADER]: proof });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      status: 'error',
      code: 'INPUT_INVALID',
      retryable: false,
      details: { reason: 'payment_identifier_required' },
    });
    expect(refused.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(backendCalls).toHaveLength(0);
  });

  it('refuses a malformed id before verification', async () => {
    const proof = await x402Proof('x402_report', 'short-id');

    const refused = await invoke('x402_report', { [PAYMENT_HEADER]: proof });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      code: 'INPUT_INVALID',
      details: { reason: 'payment_identifier_invalid' },
    });
    expect(refused.body).not.toContain('short-id');
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('answers the same id with other input with a 409 and no challenge', async () => {
    const oslo = JSON.stringify({ city: 'Oslo' });
    const rome = JSON.stringify({ city: 'Rome' });
    await invoke(
      'x402_report',
      { [PAYMENT_HEADER]: await x402Proof('x402_report', ID, oslo) },
      oslo,
    );

    const conflict = await invoke(
      'x402_report',
      { [PAYMENT_HEADER]: await x402Proof('x402_report', ID, rome) },
      rome,
    );

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      status: 'error',
      code: 'PAYMENT_REPLAYED',
      retryable: false,
      details: { reason: 'payment_identifier_conflict' },
    });
    expect(conflict.headers['retry-after']).toBeUndefined();
    expect(conflict.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
    expect(conflict.headers['www-authenticate']).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('answers a request in flight with Retry-After and retryable', async () => {
    const release = holdBackend();
    const proof = await x402Proof('x402_report', ID);
    const first = invoke('x402_report', { [PAYMENT_HEADER]: proof });
    await vi.waitFor(() => expect(backendCalls).toHaveLength(1));

    const busy = await invoke('x402_report', { [PAYMENT_HEADER]: proof });
    release();

    expect(busy.statusCode).toBe(409);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.json()).toMatchObject({
      code: 'PAYMENT_REPLAYED',
      retryable: true,
      details: { reason: 'payment_identifier_in_flight', retryAfterSeconds: 1 },
    });
    expect(busy.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
    expect((await first).statusCode).toBe(200);
  });

  it('answers a key with an unknown outcome with a 409, no Retry-After and no challenge', async () => {
    facilitator.settle.mockRejectedValueOnce(new Error('connection reset'));
    const proof = await x402Proof('x402_report', ID);
    await invoke('x402_report', { [PAYMENT_HEADER]: proof });

    const unresolved = await invoke('x402_report', {
      [PAYMENT_HEADER]: await x402Proof('x402_report', ID),
    });

    expect(unresolved.statusCode).toBe(409);
    expect(unresolved.json()).toMatchObject({
      code: 'PAYMENT_REPLAYED',
      retryable: false,
      details: { reason: 'payment_identifier_unresolved' },
    });
    expect(unresolved.headers['retry-after']).toBeUndefined();
    expect(unresolved.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('ignores an Idempotency-Key header on the x402 rail', async () => {
    const proof = await x402Proof('x402_report');

    const paid = await invoke('x402_report', { [PAYMENT_HEADER]: proof, 'idempotency-key': '' });
    const resend = await invoke('x402_report', { [PAYMENT_HEADER]: proof, 'idempotency-key': KEY });

    expect(paid.statusCode).toBe(200);
    // Idempotency-Key does not enable redelivery for x402
    expect(resend.statusCode).toBe(402);
    expect(resend.json()).toMatchObject({ code: 'PAYMENT_REPLAYED' });
    expect(resend.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('MPP retries over HTTP', () => {
  it('redelivers an exact resend after its challenge expired, with the receipt', async () => {
    const credential = await mppCredential('mpp_report');
    const first = await invoke('mpp_report', { authorization: credential, 'idempotency-key': KEY });
    mppNowMs += 301_000;

    const withoutKey = await invoke('mpp_report', { authorization: credential });
    const resend = await invoke('mpp_report', {
      authorization: credential,
      'idempotency-key': KEY,
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers['payment-receipt']).toEqual(expect.any(String));
    expect(withoutKey.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/payment-expired',
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toEqual(REPORT);
    expect(resend.headers['payment-receipt']).toBe(first.headers['payment-receipt']);
    expect(resend.headers['cache-control']).toBe('private');
    expect(resend.headers['idempotent-replayed']).toBe('true');
    expect(resend.headers[PAYMENT_RESPONSE_HEADER]).toEqual(expect.any(String));
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    // The client key never reaches the merchant
    expect(JSON.stringify(backendCalls)).not.toContain(KEY);
  });

  it('redelivers to a fresh credential for a new challenge', async () => {
    await invoke('mpp_report', {
      authorization: await mppCredential('mpp_report'),
      'idempotency-key': KEY,
    });
    mppNowMs += 301_000;

    const retry = await invoke('mpp_report', {
      authorization: await mppCredential('mpp_report'),
      'idempotency-key': KEY,
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(REPORT);
    expect(retry.headers['payment-receipt']).toEqual(expect.any(String));
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('sends no Payment-Receipt when the redelivered status is not a success', async () => {
    backendResponse = { status: 404, body: { error: 'gone' }, headers: {}, durationMs: 1 };
    const credential = await mppCredential('mpp_report');
    const first = await invoke('mpp_report', { authorization: credential, 'idempotency-key': KEY });

    const resend = await invoke('mpp_report', {
      authorization: credential,
      'idempotency-key': KEY,
    });

    // Preserve the original delivery's Payment-Receipt even for a non-2xx status
    expect(first.headers['payment-receipt']).toEqual(expect.any(String));
    expect(resend.statusCode).toBe(404);
    expect(resend.json()).toEqual({ error: 'gone' });
    expect(resend.headers['idempotent-replayed']).toBe('true');
    expect(resend.headers['cache-control']).toBe('private');
    expect(resend.headers['payment-receipt']).toBeUndefined();
  });

  it.each([
    ['an empty key', ''],
    ['256 characters', 'k'.repeat(256)],
    ['a control character', 'order\t42'],
  ])('refuses %s as bad-request Problem Details', async (_case, key) => {
    const refused = await invoke('mpp_report', { 'idempotency-key': key });

    expect(refused.statusCode).toBe(400);
    expect(refused.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(refused.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/bad-request',
      title: 'Bad Request',
      status: 400,
      code: 'INPUT_INVALID',
      details: { reason: 'payment_identifier_invalid' },
    });
    expect(refused.headers['www-authenticate']).toBeUndefined();
  });

  it.each([
    ['1', 'k'],
    ['255', 'k'.repeat(255)],
  ])('accepts a %s-character key', async (_length, key) => {
    const challenged = await invoke('mpp_report', { 'idempotency-key': key });

    expect(challenged.statusCode).toBe(402);
  });

  it('answers a key used by another payer with about:blank, never invalid-challenge', async () => {
    await invoke('mpp_report', {
      authorization: await mppCredential('mpp_report'),
      'idempotency-key': KEY,
    });

    const conflict = await invoke('mpp_report', {
      authorization: await mppCredential('mpp_report', otherBuyer),
      'idempotency-key': KEY,
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(conflict.json()).toMatchObject({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'PAYMENT_REPLAYED',
      retryable: false,
      details: { reason: 'payment_identifier_conflict' },
    });
    expect(conflict.body).not.toContain('invalid-challenge');
    expect(conflict.headers['www-authenticate']).toBeUndefined();
    expect(conflict.headers['retry-after']).toBeUndefined();
    expect(conflict.headers['payment-receipt']).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('answers a request in flight as Problem Details with Retry-After', async () => {
    const release = holdBackend();
    const credential = await mppCredential('mpp_report');
    const first = invoke('mpp_report', { authorization: credential, 'idempotency-key': KEY });
    await vi.waitFor(() => expect(backendCalls).toHaveLength(1));

    const busy = await invoke('mpp_report', { authorization: credential, 'idempotency-key': KEY });
    release();

    expect(busy.statusCode).toBe(409);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.json()).toMatchObject({
      type: 'about:blank',
      title: 'Conflict',
      retryable: true,
      details: { reason: 'payment_identifier_in_flight' },
    });
    expect(busy.headers['www-authenticate']).toBeUndefined();
    expect((await first).statusCode).toBe(200);
  });

  it('answers a charged key with no stored response as Problem Details without Retry-After', async () => {
    // MPP settles before the backend, so this failure leaves a charge behind
    backendFails = true;
    const credential = await mppCredential('mpp_report');
    await invoke('mpp_report', { authorization: credential, 'idempotency-key': KEY });

    const unresolved = await invoke('mpp_report', {
      authorization: credential,
      'idempotency-key': KEY,
    });

    expect(unresolved.statusCode).toBe(409);
    expect(unresolved.json()).toMatchObject({
      type: 'about:blank',
      title: 'Conflict',
      retryable: false,
      details: { reason: 'payment_identifier_unresolved' },
    });
    expect(unresolved.headers['retry-after']).toBeUndefined();
    expect(unresolved.headers['www-authenticate']).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('ignores the header on a resource that did not opt in', async () => {
    const malformed = await invoke('mpp_plain', { 'idempotency-key': '' });
    const credential = await mppCredential('mpp_plain');
    await invoke('mpp_plain', { authorization: credential, 'idempotency-key': KEY });

    const resend = await invoke('mpp_plain', { authorization: credential, 'idempotency-key': KEY });

    expect(malformed.statusCode).toBe(402);
    expect(resend.statusCode).toBe(402);
    expect(resend.json()).toMatchObject({ code: 'PAYMENT_REPLAYED' });
    expect(resend.headers['idempotent-replayed']).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('leaves the buyer challenge unchanged and keeps the extension from the facilitator', async () => {
    const plain = await startGateway([resource('mpp_report', ['mpp'])]);

    const optedIn = await invoke('mpp_report');
    const notOptedIn = await invoke('mpp_report', {}, '{}', plain);
    const paid = await invoke('mpp_report', {
      authorization: await mppCredential('mpp_report'),
      'idempotency-key': KEY,
    });

    expect(optedIn.headers['www-authenticate']).toMatch(/^Payment /);
    expect(optedIn.headers['www-authenticate']).toBe(notOptedIn.headers['www-authenticate']);
    expect(optedIn.body).not.toContain('payment-identifier');
    // The internal x402 requirement declares the extension; its proof echoes none
    expect(paid.statusCode).toBe(200);
    expect(
      JSON.stringify([facilitator.verify.mock.calls, facilitator.settle.mock.calls]),
    ).not.toContain('payment-identifier');
  });
});

// Send a signed x402 proof for one input on one surface
type Send = (
  resourceId: string,
  proof: string,
  input?: Record<string, unknown>,
) => Promise<unknown>;

interface Surface {
  readonly send: Send;
  // Validate the refusal format and return its error envelope
  readonly refusal: (answer: unknown, reason: string) => unknown;
}

function failedEnvelope(answer: unknown): unknown {
  const task = answer as A2aTask;
  expect(task.status.state).toBe('TASK_STATE_FAILED');
  return artifactData(task);
}

const SURFACES: [string, Surface][] = [
  [
    'MCP',
    {
      send: (resourceId, proof, input = {}) =>
        callMcp(resourceId, { ...input, [PAYMENT_INPUT_FIELD]: proof }),
      refusal(answer) {
        const result = answer as ToolResult;
        expect(result.isError).toBe(true);
        expect(result._meta?.['x402/error']).toBeUndefined();
        expect(result.structuredContent).not.toHaveProperty('accepts');
        return result.structuredContent;
      },
    },
  ],
  ['A2A _payment', { send: a2aPayment, refusal: failedEnvelope }],
  [
    'the A2A x402 extension',
    {
      send: async (resourceId, proof, input = {}) =>
        (await a2aPay(await a2aChallenge(resourceId, input), proof)).result?.task,
      refusal(answer, reason) {
        const message = (answer as A2aTask).status.message;
        expect(message?.metadata).toMatchObject({
          'x402.payment.status': 'payment-failed',
          'x402.payment.error': reason,
        });
        const envelope = failedEnvelope(answer) as { message: string };
        expect(message?.parts).toEqual([{ text: envelope.message }]);
        return envelope;
      },
    },
  ],
];

interface Refusal {
  readonly reason: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly settleCalls: number;
  // Run the retry scenario and return its final response
  readonly act: (send: Send) => Promise<unknown>;
}

const REFUSALS: [string, Refusal][] = [
  [
    'a missing id where one is required',
    {
      reason: 'payment_identifier_required',
      settleCalls: 0,
      code: 'INPUT_INVALID',
      message: 'This resource requires a payment identifier',
      retryable: false,
      act: async (send) => send('x402_required', await x402Proof('x402_required')),
    },
  ],
  [
    'a malformed id',
    {
      reason: 'payment_identifier_invalid',
      settleCalls: 0,
      code: 'INPUT_INVALID',
      message: 'A payment identifier must be 16 to 128 characters of A-Z, a-z, 0-9, "_" and "-"',
      retryable: false,
      act: async (send) => send('x402_report', await x402Proof('x402_report', 'short-id')),
    },
  ],
  [
    'the id with other input',
    {
      reason: 'payment_identifier_conflict',
      settleCalls: 1,
      code: 'PAYMENT_REPLAYED',
      message: 'This payment identifier belongs to another request',
      retryable: false,
      async act(send) {
        await send('x402_report', await x402Proof('x402_report', ID), { city: 'Oslo' });
        return send('x402_report', await x402Proof('x402_report', ID), { city: 'Rome' });
      },
    },
  ],
  [
    'the id while its request is in flight',
    {
      reason: 'payment_identifier_in_flight',
      settleCalls: 1,
      code: 'PAYMENT_REPLAYED',
      message: 'A request with this payment identifier is in progress',
      retryable: true,
      details: { retryAfterSeconds: 1 },
      async act(send) {
        const release = holdBackend();
        const proof = await x402Proof('x402_report', ID);
        const first = send('x402_report', proof);
        await vi.waitFor(() => expect(backendCalls).toHaveLength(1));
        const busy = await send('x402_report', proof);
        release();
        await first;
        return busy;
      },
    },
  ],
  [
    'the id of an unresolved request',
    {
      reason: 'payment_identifier_unresolved',
      settleCalls: 1,
      code: 'PAYMENT_REPLAYED',
      message:
        'The earlier request with this payment identifier may have been charged and has no stored response',
      retryable: false,
      async act(send) {
        facilitator.settle.mockRejectedValueOnce(new Error('connection reset'));
        await send('x402_report', await x402Proof('x402_report', ID));
        return send('x402_report', await x402Proof('x402_report', ID));
      },
    },
  ],
];

describe.each(SURFACES)('x402 retry-key refusals over %s', (_surface, surface) => {
  it.each(REFUSALS)('refuses %s with its reason and no challenge', async (_case, row) => {
    const envelope = surface.refusal(await row.act(surface.send), row.reason);

    expect(envelope).toMatchObject({
      status: 'error',
      code: row.code,
      message: row.message,
      retryable: row.retryable,
    });
    expect((envelope as { details?: unknown }).details).toEqual({
      reason: row.reason,
      ...row.details,
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(row.settleCalls);
  });
});

describe('x402 redelivery over MCP and A2A', () => {
  it('redelivers an MCP resend with the settlement response and a redelivered summary', async () => {
    const proof = await x402Proof('x402_report', ID);
    const first = await callMcp('x402_report', { [PAYMENT_INPUT_FIELD]: proof });

    const resend = await callMcp('x402_report', { [PAYMENT_INPUT_FIELD]: proof });

    expect(first.isError).toBeUndefined();
    expect(first._meta?.[DELIVERY_SUMMARY_META_KEY]).not.toHaveProperty('redelivered');
    expect(resend.isError).toBeUndefined();
    expect(resend.structuredContent).toEqual(REPORT);
    expect(resend._meta?.['x402/payment-response']).toEqual(first._meta?.['x402/payment-response']);
    expect(resend._meta?.[DELIVERY_SUMMARY_META_KEY]).toMatchObject({
      redelivered: true,
      payment: { status: 'settled', externalReference: TX },
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(backendCalls).toHaveLength(1);
  });

  it('completes an A2A _payment retry with a fresh proof as a redelivered task', async () => {
    const first = await a2aPayment('x402_report', await x402Proof('x402_report', ID));

    const retry = await a2aPayment('x402_report', await x402Proof('x402_report', ID));

    expect(summaryOf(first)).not.toHaveProperty('redelivered');
    expect(retry.status.state).toBe('TASK_STATE_COMPLETED');
    expect(artifactData(retry)).toEqual(REPORT);
    expect(summaryOf(retry)).toMatchObject({ redelivered: true, payment: { status: 'settled' } });
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('completes a new extension task paid with a fresh proof for the same id, without settling', async () => {
    const task = await a2aChallenge('x402_report');
    const paid = (await a2aPay(task, await signX402(challengeOf(task), ID))).result?.task;
    const again = await a2aChallenge('x402_report');

    const retry = (await a2aPay(again, await signX402(challengeOf(again), ID))).result?.task;

    expect(paid?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(retry?.id).toBe(again.id);
    expect(retry?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(retry?.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-completed',
      'x402.payment.receipts': [{ success: true, transaction: TX }],
    });
    expect(artifactData(retry as A2aTask)).toEqual(REPORT);
    expect(summaryOf(retry as A2aTask)).toMatchObject({ redelivered: true });
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(backendCalls).toHaveLength(1);
  });

  it('answers a resend to the consumed extension task with TaskNotFoundError', async () => {
    const task = await a2aChallenge('x402_report');
    const proof = await signX402(challengeOf(task), ID);
    await a2aPay(task, proof);

    const resend = await a2aPay(task, proof);

    expect(resend.error?.code).toBe(-32001);
    expect(resend.result).toBeUndefined();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(backendCalls).toHaveLength(1);
  });

  it.each(SURFACES.slice(1))(
    'lets a wallet that can no longer pay recover by an exact resend over %s',
    async (_surface, { send }) => {
      const proof = await x402Proof('x402_report', ID);
      await send('x402_report', proof);
      facilitator.verify.mockResolvedValue({ isValid: false, invalidReason: 'insufficient_funds' });

      const fresh = await send('x402_report', await x402Proof('x402_report', ID));
      const resend = (await send('x402_report', proof)) as A2aTask;

      expect(failedEnvelope(fresh)).toMatchObject({
        code: 'PAYMENT_INVALID',
        details: { reason: 'insufficient_funds' },
      });
      expect(resend.status.state).toBe('TASK_STATE_COMPLETED');
      expect(artifactData(resend)).toEqual(REPORT);
      expect(summaryOf(resend)).toMatchObject({ redelivered: true });
      // The exact resend reuses the stored response without another verification call
      expect(facilitator.verify).toHaveBeenCalledTimes(2);
      expect(facilitator.settle).toHaveBeenCalledTimes(1);
    },
  );
});

describe('MPP over MCP and A2A', () => {
  it('refuses an MCP credential resend as a replay, ignoring an Idempotency-Key header', async () => {
    const challenged = await callMcp('mpp_report', {});
    const payment = challenged.structuredContent?.['payment'] as {
      envelope: Record<string, unknown>;
    };
    const credential = await signMpp(payment.envelope['wwwAuthenticate']);
    const headers = { 'idempotency-key': KEY };
    const paid = await callMcp('mpp_report', { [PAYMENT_INPUT_FIELD]: credential }, headers);

    const resend = await callMcp('mpp_report', { [PAYMENT_INPUT_FIELD]: credential }, headers);

    expect(paid.isError).toBeUndefined();
    expect(resend.isError).toBe(true);
    expect(resend.structuredContent).toMatchObject({ code: 'PAYMENT_REPLAYED' });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(backendCalls).toHaveLength(1);
  });

  it('refuses an A2A credential resend as a replay, ignoring an Idempotency-Key header', async () => {
    const challenged = await sendA2a(buyMessage('mpp_report', {}));
    const payment = artifactData(challenged.result?.task as A2aTask)?.['payment'] as {
      envelope: Record<string, unknown>;
    };
    const credential = await signMpp(payment.envelope['wwwAuthenticate']);
    const message = buyMessage('mpp_report', { [PAYMENT_INPUT_FIELD]: credential });
    const headers = { 'idempotency-key': KEY };
    const paid = (await sendA2a(message, headers)).result?.task;

    const resend = (await sendA2a(message, headers)).result?.task;

    expect(paid?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(failedEnvelope(resend)).toMatchObject({ code: 'PAYMENT_REPLAYED' });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(backendCalls).toHaveLength(1);
  });
});
