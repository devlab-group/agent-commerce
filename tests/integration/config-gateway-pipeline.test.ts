/**
 * Cross-package integration: config.yaml -> src/config
 * -> src/gateway (which wires src/core's
 * execution pipeline internally). No dependency on protocol-mcp, payment-x402
 * or receipt-store — those are fakes here, so a failure points at the
 * config/gateway/pipeline seam and not at an adapter.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Keep test output quiet and avoid spawning a pino-pretty worker thread.
process.env['NODE_ENV'] = 'test';

import { loadConfig, parseConfig } from '../../src/config/index.js';
import {
  type AdapterDescriptor,
  type Clock,
  CommerceError,
  type CommerceEvent,
  type CommerceReceipt,
  type IdGenerator,
  isCommerceError,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type PaymentAttempt,
  type PaymentContext,
  type PaymentProvider,
  type PaymentRequirement,
  type PaymentResult,
  type PaymentSettlementContext,
  type PaymentVerificationContext,
  type ReceiptStore,
} from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';

const descriptor: AdapterDescriptor = {
  name: 'fake',
  kind: 'storage',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'n/a',
  capabilities: [],
  status: 'experimental',
};

function createFakeStore(): ReceiptStore & {
  events: CommerceEvent[];
  receipts: CommerceReceipt[];
} {
  const events: CommerceEvent[] = [];
  const receipts: CommerceReceipt[] = [];
  const attempts = new Map<string, PaymentAttempt>();
  const store: ReceiptStore & { events: CommerceEvent[]; receipts: CommerceReceipt[] } = {
    events,
    receipts,
    async init() {},
    async appendEvent(event) {
      events.push(event);
    },
    async reservePaymentAttempt(reservation) {
      if (attempts.has(reservation.replayKey)) {
        throw new CommerceError('PAYMENT_REPLAYED', 'duplicate replay key');
      }
      const attempt: PaymentAttempt = {
        id: `attempt-${attempts.size + 1}`,
        requestId: reservation.requestId,
        resourceId: reservation.resourceId,
        provider: reservation.provider,
        replayKey: reservation.replayKey,
        status: 'reserved',
        amount: reservation.amount,
        currency: reservation.currency,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      attempts.set(reservation.replayKey, attempt);
      return attempt;
    },
    async updatePaymentAttempt(update) {
      const existing = attempts.get(update.replayKey);
      if (existing) attempts.set(update.replayKey, { ...existing, status: update.status });
    },
    async saveReceipt(receipt) {
      receipts.push(receipt);
    },
    async getReceipt(id) {
      return receipts.find((r) => r.id === id);
    },
    async listReceipts() {
      return receipts;
    },
    async countReceipts() {
      return receipts.length;
    },
    async countUndeliveredReceipts() {
      return receipts.filter((r) => r.backendStatus < 200 || r.backendStatus > 299).length;
    },
    async listEvents() {
      return events;
    },
    async listPaymentAttempts() {
      return [...attempts.values()];
    },
    descriptor: { ...descriptor, name: 'fake-store', kind: 'storage' },
    async health() {
      return { status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' };
    },
    async close() {},
  };
  return store;
}

function createFakeX402Provider(): PaymentProvider {
  return {
    name: 'x402',
    descriptor: { ...descriptor, name: 'fake-x402', kind: 'payment' },
    createRequirement: async (ctx: PaymentContext): Promise<PaymentRequirement> => ({
      id: 'req-1',
      requestId: ctx.requestId,
      resourceId: ctx.resource.id,
      provider: 'x402',
      amount: ctx.amount,
      currency: ctx.currency,
      destination: '0xMERCHANT',
      challenge: { provider: 'x402', version: '1', accepts: [{ scheme: 'exact' }] },
    }),
    verify: async (ctx: PaymentVerificationContext): Promise<PaymentResult> => ({
      status: ctx.submission.payload === 'valid-proof' ? 'verified' : 'rejected',
      provider: 'x402',
      amount: '0.01',
      currency: 'USDC',
      replayKey: `replay-${ctx.submission.payload}`,
    }),
    settle: async (_ctx: PaymentSettlementContext): Promise<PaymentResult> => ({
      status: 'settled',
      provider: 'x402',
      amount: '0.01',
      currency: 'USDC',
      externalReference: '0xTXHASH',
    }),
    health: async () => ({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' }),
  };
}

const clock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  nowIso: () => '2026-01-01T00:00:00.000Z',
  monotonicMs: () => Date.now(),
};

const ids: IdGenerator = (() => {
  let n = 0;
  return { next: (prefix?: string) => `${prefix ?? 'id'}-${++n}` };
})();

const YAML_TEXT = `
version: 1
merchant:
  id: demo-store
  name: Demo Data Store
  publicBaseUrl: \${GATEWAY_PUBLIC_BASE_URL}
server:
  port: 0
  host: 127.0.0.1
storage:
  receipts:
    driver: sqlite
    path: ":memory:"
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources:
  weather_basic:
    name: Basic Weather
    input:
      type: object
      properties:
        city:
          type: string
      required: [city]
      additionalProperties: false
    backend:
      type: http
      method: GET
      url: \${MERCHANT_API_BASE_URL}/api/weather/{city}
      timeoutMs: 5000
    pricing:
      type: free
    expose: [http, mcp]
  market_report:
    name: Premium Market Report
    input:
      type: object
      properties: {}
      additionalProperties: false
    backend:
      type: http
      method: GET
      url: \${MERCHANT_API_BASE_URL}/api/report
    pricing:
      type: fixed
      amount: "0.01"
      currency: USDC
    expose: [http, mcp]
    payments: [x402]
payments:
  x402:
    enabled: true
    network: \${X402_NETWORK}
    rpcUrl: \${X402_RPC_URL}
    asset: \${X402_ASSET}
    assetName: MockUSDC
    assetVersion: "2"
    assetDecimals: 6
    payTo: \${MERCHANT_WALLET}
    maxTimeoutSeconds: 120
    facilitator:
      mode: local
      signerPrivateKey: \${X402_FACILITATOR_PRIVATE_KEY}
`;

const ENV = {
  GATEWAY_PUBLIC_BASE_URL: 'http://localhost:8080',
  MERCHANT_API_BASE_URL: 'http://merchant.internal:3000',
  X402_NETWORK: 'base-sepolia',
  X402_RPC_URL: 'http://127.0.0.1:8545',
  X402_ASSET: '0x1111111111111111111111111111111111111111',
  MERCHANT_WALLET: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  X402_FACILITATOR_PRIVATE_KEY: '0xTHIS_IS_A_TEST_ONLY_SECRET_KEY',
};

let gateways: GatewayInstance[] = [];
let tmpDir: string | undefined;

afterEach(async () => {
  await Promise.all(gateways.map((g) => g.close().catch(() => {})));
  gateways = [];
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('config -> gateway -> core execution pipeline (integration)', () => {
  it('loads YAML from disk, resolves env, and serves a free resource end to end', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oac-integration-'));
    const file = path.join(tmpDir, 'config.yaml');
    await fs.writeFile(file, YAML_TEXT, 'utf8');

    const config = await loadConfig({ path: file, env: ENV });
    expect(config.resources).toHaveLength(2);

    const store = createFakeStore();
    const backendCalls: unknown[] = [];
    const gateway = await createGateway({
      config,
      store,
      paymentProviders: [createFakeX402Provider()],
      protocolAdapters: [],
      clock,
      ids,
      backend: {
        call: async (_handler, request) => {
          backendCalls.push(request);
          return { status: 200, headers: {}, body: { city: 'Berlin', tempC: 20 }, durationMs: 2 };
        },
      },
    });
    gateways.push(gateway);

    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'Berlin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ city: 'Berlin', tempC: 20 });
    expect(backendCalls).toHaveLength(1);
    expect(store.receipts).toHaveLength(1);
  });

  it('a paid resource end to end: 402 challenge, then delivery with a valid proof, backed by real config parsing', () => {
    return (async () => {
      const raw = buildRawConfig();
      const config = parseConfig(raw, ENV);

      const store = createFakeStore();
      const gateway = await createGateway({
        config,
        store,
        paymentProviders: [createFakeX402Provider()],
        protocolAdapters: [],
        clock,
        ids,
        backend: {
          call: async () => ({
            status: 200,
            headers: {},
            body: { report: 'premium data' },
            durationMs: 1,
          }),
        },
      });
      gateways.push(gateway);

      const challenge = await gateway.server.inject({
        method: 'POST',
        url: '/api/resources/market_report/invoke',
        payload: {},
      });
      expect(challenge.statusCode).toBe(402);
      expect(challenge.json().code).toBe('PAYMENT_REQUIRED');

      const paid = await gateway.server.inject({
        method: 'POST',
        url: '/api/resources/market_report/invoke',
        headers: { [PAYMENT_HEADER]: 'valid-proof' },
        payload: {},
      });
      expect(paid.statusCode).toBe(200);
      expect(paid.json()).toEqual({ report: 'premium data' });
      expect(paid.headers[PAYMENT_RESPONSE_HEADER]).toBeDefined();
      expect(store.receipts).toHaveLength(1);
      expect(store.receipts[0]?.payment?.status).toBe('settled');
    })();
  });

  it('config validation errors surface before any gateway is created, and never print the facilitator key', () => {
    const raw = buildRawConfig();
    (raw.payments as { x402: Record<string, unknown> }).x402['payTo'] = 'not-an-address';

    let thrown: unknown;
    try {
      parseConfig(raw, ENV);
    } catch (error) {
      thrown = error;
    }
    expect(isCommerceError(thrown)).toBe(true);
    if (isCommerceError(thrown)) {
      expect(thrown.code).toBe('CONFIG_INVALID');
      expect(JSON.stringify(thrown.details)).not.toContain(ENV.X402_FACILITATOR_PRIVATE_KEY);
      expect(thrown.message).not.toContain(ENV.X402_FACILITATOR_PRIVATE_KEY);
    }
  });

  it('the well-known endpoint never leaks the facilitator private key end to end', async () => {
    const raw = buildRawConfig();
    const config = parseConfig(raw, ENV);
    const store = createFakeStore();
    const gateway = await createGateway({
      config,
      store,
      paymentProviders: [createFakeX402Provider()],
      protocolAdapters: [],
      clock,
      ids,
    });
    gateways.push(gateway);

    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(ENV.X402_FACILITATOR_PRIVATE_KEY);
    expect(res.json().payments.x402.payTo).toBe(ENV.MERCHANT_WALLET);
  });
});

function buildRawConfig(): Record<string, unknown> {
  return {
    version: 1,
    merchant: {
      id: 'demo-store',
      name: 'Demo Data Store',
      publicBaseUrl: '${GATEWAY_PUBLIC_BASE_URL}',
    },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
    resources: {
      market_report: {
        name: 'Premium Market Report',
        input: { type: 'object', properties: {}, additionalProperties: false },
        backend: { type: 'http', method: 'GET', url: '${MERCHANT_API_BASE_URL}/api/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        expose: ['http', 'mcp'],
        payments: ['x402'],
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: '${X402_NETWORK}',
        rpcUrl: '${X402_RPC_URL}',
        asset: '${X402_ASSET}',
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: '${MERCHANT_WALLET}',
        maxTimeoutSeconds: 120,
        facilitator: { mode: 'local', signerPrivateKey: '${X402_FACILITATOR_PRIVATE_KEY}' },
      },
    },
  };
}
