/**
 * One MPP payment over each surface, through the real gateway and adapters.
 *
 * HTTP carries MPP in its own authentication headers. MCP and A2A carry the
 * same credential string in `_payment`. The provider and the x402 settlement
 * provider are real; only the x402 HTTP facilitator client is mocked.
 */
import { createHash } from 'node:crypto';
import { Challenge, Receipt } from 'mppx';
import { Mppx } from 'mppx/client';
import { charge as clientCharge } from 'mppx/evm/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../src/config';
import {
  type BackendExecutor,
  PAYMENT_HEADER,
  PAYMENT_INPUT_FIELD,
  type ReceiptStore,
} from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createMppPaymentProvider, type MppProviderOptions } from '../../src/payments/mpp/provider';
import { createA2aAdapter } from '../../src/protocols/a2a';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createSqliteReceiptStore } from '../../src/storage/receipts';
import { createFakeStore } from '../unit/gateway/helpers';

process.env['NODE_ENV'] = 'test';

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitator.verify(...args);
    }
    settle(...args: unknown[]) {
      return facilitator.settle(...args);
    }
  },
}));

const ASSET = '0x1111111111111111111111111111111111111111' as const;
const AUTHORIZATION = { name: 'MockUSDC', version: '2' };
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const buyer = privateKeyToAccount(generatePrivateKey());
const REPORT = { report: 'paid' };

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

let gateway: GatewayInstance | undefined;

beforeEach(() => {
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true });
  facilitator.settle
    .mockReset()
    .mockResolvedValue({ success: true, transaction: '0xabc', network: 'eip155:84532' });
});

afterEach(async () => {
  await gateway?.close().catch(() => {});
  gateway = undefined;
});

function config(): GatewayConfig {
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
      a2a: { enabled: true, mountPath: '/a2a' },
      acp: { enabled: false, mountPath: '/acp' },
    },
    resources: [
      {
        id: 'market_report',
        name: 'Market report',
        description: 'A paid report.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        exposedVia: ['http', 'mcp', 'a2a'],
        paymentMethods: ['mpp'],
      },
    ],
    payments: {},
  };
}

const backend: BackendExecutor = {
  async call() {
    return { status: 200, body: REPORT, headers: {}, durationMs: 1 };
  },
};

async function startGateway(
  store: ReceiptStore = createFakeStore(),
  backendExecutor: BackendExecutor = backend,
  mpp: Partial<MppProviderOptions> = {},
): Promise<GatewayInstance> {
  gateway = await createGateway({
    config: config(),
    store,
    paymentProviders: [
      createMppPaymentProvider({
        recipient,
        asset: ASSET,
        assetName: AUTHORIZATION.name,
        assetVersion: AUTHORIZATION.version,
        realm: 'gateway.test',
        challengeSecret: 's'.repeat(32),
        rpcUrl: 'http://127.0.0.1:19321', // never contacted: the facilitator client is mocked
        facilitator: {
          mode: 'remote',
          url: 'https://facilitator.example.com',
          auth: { type: 'none' },
        },
        ...mpp,
      }),
    ],
    protocolAdapters: [createMcpAdapter(), createA2aAdapter()],
    backend: backendExecutor,
  });
  return gateway;
}

async function credentialFor(wwwAuthenticate: unknown): Promise<string> {
  expect(typeof wwwAuthenticate).toBe('string');
  const challenge = Challenge.deserialize(wwwAuthenticate as string) as unknown as EvmChallenge;
  const client = clientCharge({ account: buyer, authorization: AUTHORIZATION });
  return String(await client.createCredential({ challenge, context: {} }));
}

function invokeHttp(gw: GatewayInstance, headers: Record<string, string> = {}, body = '{}') {
  return gw.server.inject({
    method: 'POST',
    url: '/api/resources/market_report/invoke',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function callMcp(gw: GatewayInstance, args: Record<string, unknown>): Promise<McpToolResult> {
  const res = await gw.server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'market_report', arguments: args },
    },
  });
  // Streamable HTTP can frame the reply as a single SSE event
  const raw = res.body.startsWith('event:')
    ? (res.body.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)
    : res.body;
  return (JSON.parse(raw) as { result: McpToolResult }).result;
}

async function callA2a(
  gw: GatewayInstance,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const res = await gw.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: {
        message: {
          role: 'ROLE_USER',
          messageId: 'msg-1',
          parts: [{ data: { resource: 'market_report', input }, mediaType: 'application/json' }],
        },
      },
    }),
  });
  const body = res.json<{
    result?: { task?: { artifacts: { parts: { data: Record<string, unknown> }[] }[] } };
  }>();
  return body.result?.task?.artifacts[0]?.parts[0]?.data;
}

function wwwAuthenticateOf(envelope: Record<string, unknown> | undefined): unknown {
  const payment = envelope?.['payment'] as { envelope?: { wwwAuthenticate?: unknown } } | undefined;
  return payment?.envelope?.wwwAuthenticate;
}

const failingBackend: BackendExecutor = {
  async call() {
    throw new Error('backend down');
  },
};

describe('MPP over HTTP', () => {
  it('answers an unpaid request with a payment-required problem document', async () => {
    const gw = await startGateway();

    const challenged = await invokeHttp(gw);

    expect(challenged.statusCode).toBe(402);
    expect(challenged.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(challenged.headers['www-authenticate']).toMatch(/^Payment /);
    expect(challenged.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: expect.stringContaining('Payment of 0.01 USDC is required'),
      code: 'PAYMENT_REQUIRED',
      resourceId: 'market_report',
      payment: { provider: 'mpp' },
    });
  });

  it('accepts the mppx fetch retry from a problem-document challenge', async () => {
    const gw = await startGateway();
    const client = Mppx.create({
      methods: [clientCharge({ account: buyer, authorization: AUTHORIZATION })],
      polyfill: false,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const res = await gw.server.inject({
          method: 'POST',
          url: new URL(request.url).pathname,
          headers: Object.fromEntries(request.headers),
          payload: await request.text(),
        });
        return new Response(res.body, {
          status: res.statusCode,
          headers: res.headers as Record<string, string>,
        });
      },
    });

    const paid = await client.fetch('http://gateway.test/api/resources/market_report/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual(REPORT);
    expect(paid.headers.get('payment-receipt')).not.toBeNull();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('challenges with WWW-Authenticate, accepts Authorization: Payment and returns Payment-Receipt', async () => {
    const gw = await startGateway();

    const challenged = await invokeHttp(gw);
    expect(challenged.statusCode).toBe(402);
    expect(challenged.headers['payment-required']).toBeUndefined();
    const credential = await credentialFor(challenged.headers['www-authenticate']);

    const paid = await invokeHttp(gw, { authorization: credential });

    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual(REPORT);
    const receipt = Receipt.deserialize(String(paid.headers['payment-receipt']));
    // Check the EVM receipt's challenge and chain identifiers
    expect(receipt).toMatchObject({
      method: 'evm',
      reference: '0xabc',
      status: 'success',
      challengeId: Challenge.deserialize(String(challenged.headers['www-authenticate'])).id,
      chainId: 84532,
    });
    expect(paid.headers['cache-control']).toBe('private');
  });

  it('persists a settled payment and rejects the credential replay', async () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
    const gw = await startGateway(store);
    const credential = await credentialFor((await invokeHttp(gw)).headers['www-authenticate']);

    expect((await invokeHttp(gw, { authorization: credential })).statusCode).toBe(200);
    const replayed = await invokeHttp(gw, { authorization: credential });

    // A spent credential returns 402 with a new challenge and the
    // invalid-challenge problem type
    expect(replayed.statusCode).toBe(402);
    expect(replayed.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(replayed.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/invalid-challenge',
      status: 402,
      code: 'PAYMENT_REPLAYED',
    });
    expect(replayed.headers['www-authenticate']).toMatch(/^Payment /);
    const [receipt] = await store.listReceipts();
    expect(receipt?.payment).toMatchObject({
      provider: 'mpp',
      status: 'settled',
      externalReference: '0xabc',
      network: 'eip155:84532',
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    await store.close();
  });

  it('answers a rejected credential with a fresh challenge the client can pay', async () => {
    const gw = await startGateway();
    const first = (await invokeHttp(gw)).headers['www-authenticate'];
    facilitator.verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'insufficient_funds',
    });

    const refused = await invokeHttp(gw, { authorization: await credentialFor(first) });

    expect(refused.statusCode).toBe(402);
    expect(refused.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(refused.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail: 'The payment was refused: insufficient_funds.',
      code: 'PAYMENT_INVALID',
      details: { reason: 'insufficient_funds' },
    });
    expect(refused.headers['cache-control']).toBe('no-store');
    const fresh = refused.headers['www-authenticate'];
    expect(fresh).not.toBe(first);
    const paid = await invokeHttp(gw, { authorization: await credentialFor(fresh) });
    expect(paid.statusCode).toBe(200);
  });

  it('reports a spent nonce as an already-used challenge', async () => {
    const gw = await startGateway();
    const first = (await invokeHttp(gw)).headers['www-authenticate'];
    facilitator.verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'invalid_exact_evm_nonce_already_used',
    });

    const refused = await invokeHttp(gw, { authorization: await credentialFor(first) });

    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/invalid-challenge',
      title: 'Invalid Challenge',
      status: 402,
      detail: 'The challenge has already been used for a payment.',
      code: 'PAYMENT_INVALID',
      details: { reason: 'challenge_already_used' },
    });
    const fresh = refused.headers['www-authenticate'];
    expect(fresh).toMatch(/^Payment /);
    expect(fresh).not.toBe(first);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('withholds the response and rechallenges after settlement refusal', async () => {
    let backendCalls = 0;
    const counting: BackendExecutor = {
      async call() {
        backendCalls += 1;
        return { status: 200, body: REPORT, headers: {}, durationMs: 1 };
      },
    };
    const gw = await startGateway(createFakeStore(), counting);
    const first = (await invokeHttp(gw)).headers['www-authenticate'];
    facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'eip155:84532',
    });

    const refused = await invokeHttp(gw, { authorization: await credentialFor(first) });

    expect(backendCalls).toBe(1);
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/verification-failed',
      code: 'PAYMENT_SETTLEMENT_FAILED',
    });
    expect(refused.json()).not.toHaveProperty('report');
    const fresh = refused.headers['www-authenticate'];
    expect(fresh).toMatch(/^Payment /);
    expect(fresh).not.toBe(first);
    const settlement = JSON.parse(
      Buffer.from(String(refused.headers['payment-response']), 'base64').toString('utf8'),
    );
    expect(settlement).toMatchObject({ success: false, errorReason: 'insufficient_funds' });
    expect(refused.headers['payment-receipt']).toBeUndefined();
  });

  it('does not settle or reuse a credential after backend failure', async () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
    const gw = await startGateway(store, failingBackend);
    const credential = await credentialFor((await invokeHttp(gw)).headers['www-authenticate']);

    const failed = await invokeHttp(gw, { authorization: credential });

    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: 'BACKEND_ERROR' });
    expect(failed.json().details ?? {}).not.toHaveProperty('payment');
    expect(failed.headers['payment-receipt']).toBeUndefined();
    expect(failed.headers['payment-response']).toBeUndefined();
    expect((await store.listPaymentAttempts())[0]).toMatchObject({
      status: 'rejected',
      rejectionReason: 'backend_failed',
    });

    // The unspent nonce still passes the facilitator check, so the gateway's
    // reservation is what refuses the second presentation
    const again = await invokeHttp(gw, { authorization: credential });

    expect(again.statusCode).toBe(402);
    expect(again.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/invalid-challenge',
      code: 'PAYMENT_REPLAYED',
    });
    expect(again.headers['www-authenticate']).toMatch(/^Payment /);
    expect(facilitator.settle).not.toHaveBeenCalled();
    await store.close();
  });

  it('reports an upfront settlement after backend failure without Payment-Receipt', async () => {
    const gw = await startGateway(createFakeStore(), failingBackend, { paymentFlow: 'upfront' });
    const credential = await credentialFor((await invokeHttp(gw)).headers['www-authenticate']);

    const res = await invokeHttp(gw, { authorization: credential });

    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({ code: 'BACKEND_ERROR' });
    // MPP puts the receipt in the error body, not a Payment-Receipt header
    expect(res.headers['payment-receipt']).toBeUndefined();
    expect(res.headers['payment-response']).toBeDefined();
    const receipt = Receipt.deserialize(String(res.json().details.payment.receipt));
    expect(receipt).toMatchObject({ method: 'evm', reference: '0xabc', status: 'success' });
  });

  it('binds the digest of the request body bytes into the challenge', async () => {
    const gw = await startGateway();

    const challenged = await invokeHttp(gw, {}, '{ }');

    const digest = createHash('sha256').update('{ }').digest('base64');
    expect(Challenge.deserialize(String(challenged.headers['www-authenticate'])).digest).toBe(
      `sha-256=:${digest}:`,
    );
  });

  it('refuses a credential sent with a different body, then settles it with the original', async () => {
    const gw = await startGateway();
    const credential = await credentialFor(
      (await invokeHttp(gw, {}, '{ }')).headers['www-authenticate'],
    );

    // The same JSON in different bytes is a different body
    const swapped = await invokeHttp(gw, { authorization: credential }, '{}');

    expect(swapped.statusCode).toBe(402);
    expect(swapped.json()).toMatchObject({
      type: 'https://paymentauth.org/problems/verification-failed',
      detail: 'The request body differs from the one the challenge was issued for.',
      message: 'body_digest_mismatch',
      code: 'PAYMENT_INVALID',
    });
    expect(facilitator.settle).not.toHaveBeenCalled();
    const paid = await invokeHttp(gw, { authorization: credential }, '{ }');
    expect(paid.statusCode).toBe(200);
  });

  it('treats an Authorization header in another scheme as no payment', async () => {
    const gw = await startGateway();
    const res = await invokeHttp(gw, { authorization: 'Bearer operator-token' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('ignores an MPP credential sent in the x402 payment header', async () => {
    const gw = await startGateway();
    const credential = await credentialFor((await invokeHttp(gw)).headers['www-authenticate']);
    const res = await invokeHttp(gw, { [PAYMENT_HEADER]: credential });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});

describe('MPP over MCP and A2A', () => {
  it('settles a credential passed in the MCP _payment argument', async () => {
    const gw = await startGateway();
    const challenged = await callMcp(gw, {});
    const credential = await credentialFor(wwwAuthenticateOf(challenged.structuredContent));

    const paid = await callMcp(gw, { [PAYMENT_INPUT_FIELD]: credential });

    expect(paid.isError).not.toBe(true);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('settles a credential passed in the A2A _payment input field', async () => {
    const gw = await startGateway();
    const credential = await credentialFor(wwwAuthenticateOf(await callA2a(gw, {})));

    const paid = await callA2a(gw, { [PAYMENT_INPUT_FIELD]: credential });

    expect(paid).toEqual(REPORT);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
});
