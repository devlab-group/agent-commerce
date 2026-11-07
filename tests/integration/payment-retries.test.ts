/**
 * Exercise HTTP retries through the gateway, x402 and MPP providers, and SQLite.
 * An injected backend controls delivery; a mocked x402 facilitator client
 * counts verification and settlement calls without contacting a chain.
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
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createMppPaymentProvider } from '../../src/payments/mpp/provider';
import { createPaymentProof } from '../../src/payments/x402/client';
import { createX402PaymentProvider } from '../../src/payments/x402/provider';
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
    exposedVia: ['http'],
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
      mcp: { enabled: false, mountPath: '/mcp' },
      a2a: { enabled: false, mountPath: '/a2a' },
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
    protocolAdapters: [],
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

// Sign a fresh x402 challenge, echoing its declaration with `id` when supplied
async function x402Proof(resourceId: string, id?: string, body = '{}'): Promise<string> {
  const required = decodeHeader(
    (await invoke(resourceId, {}, body)).headers[PAYMENT_REQUIRED_HEADER],
  );
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

// Answer a fresh MPP challenge
async function mppCredential(
  resourceId: string,
  account: PrivateKeyAccount = buyer,
  instance: GatewayInstance = gateway,
): Promise<string> {
  const challenged = await invoke(resourceId, {}, '{}', instance);
  const challenge = Challenge.deserialize(
    String(challenged.headers['www-authenticate']),
  ) as unknown as EvmChallenge;
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

  it('answers a key with an unknown outcome as Problem Details without Retry-After', async () => {
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
