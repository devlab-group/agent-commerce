/**
 * One MPP payment over each surface, through the real gateway and adapters.
 *
 * HTTP carries MPP in its own authentication headers. MCP and A2A carry the
 * same credential string in `_payment`. The provider and the x402 settlement
 * provider are real; only the x402 HTTP facilitator client is mocked.
 */
import { Challenge, Receipt } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../src/config/index.js';
import { type BackendExecutor, PAYMENT_HEADER, PAYMENT_INPUT_FIELD } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createMppPaymentProvider } from '../../src/payments/mpp/provider.js';
import { createX402PaymentProvider } from '../../src/payments/x402/provider.js';
import { createA2aAdapter } from '../../src/protocols/a2a/index.js';
import { createMcpAdapter } from '../../src/protocols/mcp/index.js';
import { createFakeStore } from '../unit/gateway/helpers.js';

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

async function startGateway(): Promise<GatewayInstance> {
  const settlement = createX402PaymentProvider({
    network: 'eip155:84532',
    rpcUrl: 'http://127.0.0.1:19321', // never contacted: the facilitator client is mocked
    asset: ASSET,
    assetName: AUTHORIZATION.name,
    assetVersion: AUTHORIZATION.version,
    assetDecimals: 6,
    payTo: recipient,
    facilitator: { mode: 'remote', url: 'https://facilitator.example.com', auth: { type: 'none' } },
  });
  gateway = await createGateway({
    config: config(),
    store: createFakeStore(),
    paymentProviders: [
      createMppPaymentProvider({
        recipient,
        asset: ASSET,
        assetName: AUTHORIZATION.name,
        assetVersion: AUTHORIZATION.version,
        realm: 'gateway.test',
        challengeSecret: 's'.repeat(32),
        settlement,
      }),
    ],
    protocolAdapters: [createMcpAdapter(), createA2aAdapter()],
    backend,
  });
  return gateway;
}

async function credentialFor(wwwAuthenticate: unknown): Promise<string> {
  expect(typeof wwwAuthenticate).toBe('string');
  const challenge = Challenge.deserialize(wwwAuthenticate as string) as unknown as EvmChallenge;
  const client = clientCharge({ account: buyer, authorization: AUTHORIZATION });
  return String(await client.createCredential({ challenge, context: {} }));
}

function invokeHttp(gw: GatewayInstance, headers: Record<string, string> = {}) {
  return gw.server.inject({
    method: 'POST',
    url: '/api/resources/market_report/invoke',
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
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

describe('MPP over HTTP', () => {
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
    expect(receipt).toMatchObject({ method: 'evm', reference: '0xabc', status: 'success' });
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
