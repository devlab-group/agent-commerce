import { spawn } from 'node:child_process';
import * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep test output quiet and avoid spawning a pino-pretty worker thread per
// Fastify instance created below (many are created across this file).
process.env['NODE_ENV'] = 'test';

import type {
  BackendExecutor,
  CanonicalRequest,
  Clock,
  ExecutionPipeline,
  IdGenerator,
  Logger,
} from '../../../src/core/index.js';
import { PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER } from '../../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../../src/gateway/server.js';
import {
  createFakeHttpAdapter,
  createFakePaymentProvider,
  createFakeProtocolAdapter,
  createFakeStore,
  makeGatewayConfig,
} from './helpers.js';

function createFakeClock(): Clock {
  let counter = 0;
  return {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    nowIso: () => '2026-01-01T00:00:00.000Z',
    monotonicMs: () => {
      counter += 1;
      return counter;
    },
  };
}

function createFakeIdGenerator(): IdGenerator {
  let n = 0;
  return { next: (prefix?: string) => `${prefix ?? 'id'}-${++n}` };
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

const ADMIN_TOKEN = 'test-admin-token';
function adminHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function createFakeBackend(
  impl?: (
    handler: unknown,
    request: { requestId: string; resourceId: string; input: unknown },
  ) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
    durationMs: number;
  }>,
): BackendExecutor {
  return {
    call:
      (impl as BackendExecutor['call'] | undefined) ??
      (async () => ({ status: 200, headers: {}, body: { ok: true }, durationMs: 1 })),
  };
}

/**
 * Wraps the live `execute()` on the gateway's own pipeline instance (the same
 * object reference the invoke route closed over) so we can assert on the
 * exact `CanonicalRequest` the route built, without re-implementing routing.
 */
function spyOnPipelineExecute(gateway: GatewayInstance): CanonicalRequest[] {
  const captured: CanonicalRequest[] = [];
  const original = gateway.pipeline.execute.bind(gateway.pipeline);
  (gateway.pipeline as { execute: ExecutionPipeline['execute'] }).execute = async (request) => {
    captured.push(request);
    return original(request);
  };
  return captured;
}

let gateways: GatewayInstance[] = [];

async function buildGateway(
  options: Partial<Parameters<typeof createGateway>[0]> = {},
): Promise<GatewayInstance> {
  const gateway = await createGateway({
    config: makeGatewayConfig(),
    store: createFakeStore(),
    paymentProviders: [],
    protocolAdapters: [],
    backend: createFakeBackend(),
    logger: NOOP_LOGGER,
    clock: createFakeClock(),
    ids: createFakeIdGenerator(),
    ...options,
  });
  gateways.push(gateway);
  return gateway;
}

afterEach(async () => {
  await Promise.all(gateways.map((g) => g.close().catch(() => {})));
  gateways = [];
});

describe('createGateway HTTP surface', () => {
  it('accepts a well-formed client x-request-id as the correlation key', async () => {
    const gateway = await buildGateway();
    const captured = spyOnPipelineExecute(gateway);
    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      headers: { 'x-request-id': 'client-flow-abc.123:v2' },
      payload: { city: 'Berlin' },
    });
    expect(captured[0]?.requestId).toBe('client-flow-abc.123:v2');
  });

  it('mints its own request id when the caller supplies an out-of-pattern one', async () => {
    const gateway = await buildGateway();
    const captured = spyOnPipelineExecute(gateway);
    const hostile = 'x'.repeat(5000);

    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      headers: { 'x-request-id': hostile },
      payload: { city: 'Berlin' },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.requestId).not.toBe(hostile);
    expect(captured[0]?.requestId.length).toBeLessThan(200);
  });

  it('rejects a request id containing characters outside the allowed set', async () => {
    const gateway = await buildGateway();
    const captured = spyOnPipelineExecute(gateway);

    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      headers: { 'x-request-id': 'legit-id/../with-slash' },
      payload: { city: 'Berlin' },
    });

    expect(captured[0]?.requestId).not.toBe('legit-id/../with-slash');
  });

  it('GET /health always returns 200', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready is 200 when store and adapters are healthy', async () => {
    const gateway = await buildGateway({ protocolAdapters: [createFakeProtocolAdapter()] });
    const res = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
  });

  it('GET /ready is 503 when the store is unhealthy', async () => {
    const store = createFakeStore();
    store.healthStatus = 'fail';
    const gateway = await buildGateway({ store });
    const res = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().ready).toBe(false);
  });

  it('GET /ready is 503 when a required adapter is unhealthy', async () => {
    const badAdapter = createFakeProtocolAdapter({
      health: async () => ({ status: 'fail', checkedAt: 'x' }),
    });
    const gateway = await buildGateway({ protocolAdapters: [badAdapter] });
    const res = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
  });

  it('GET /ready is 503 when a payment provider is unhealthy (informational: wire payment health into readiness)', async () => {
    const badProvider = {
      ...createFakePaymentProvider(),
      health: async () => ({ status: 'fail' as const, checkedAt: 'x' }),
    };
    const gateway = await buildGateway({ paymentProviders: [badProvider] });
    const res = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().ready).toBe(false);
    expect(res.json().paymentProviders).toEqual([
      { name: 'x402', status: 'fail', detail: 'payment-provider-unreachable' },
    ]);
  });

  it('GET /ready is 200 when the only payment provider reports warn (degraded, still serving)', async () => {
    const warnProvider = {
      ...createFakePaymentProvider(),
      health: async () => ({ status: 'warn' as const, checkedAt: 'x' }),
    };
    const gateway = await buildGateway({ paymentProviders: [warnProvider] });
    const res = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
    expect(res.json().paymentProviders[0].detail).toBe('payment-provider-degraded');
  });

  it('GET /.well-known/agent-commerce exposes merchant, adapters and the x402 destination, and never the private key', async () => {
    const gateway = await buildGateway({
      paymentProviders: [createFakePaymentProvider()],
      protocolAdapters: [createFakeProtocolAdapter()],
    });
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.merchant.id).toBe('demo-store');
    expect(body.payments.x402.payTo).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(body.payments.x402.network).toBe('eip155:84532');
    expect(body.adapters).toHaveLength(1);
    expect(body.paymentProviders).toHaveLength(1);
    expect(body.store).toBeDefined();

    const raw = res.payload;
    expect(raw).not.toContain('TOTALLY_SECRET_KEY');
    expect(raw).not.toContain('signerPrivateKey');
  });

  it('never publishes rpcUrl on.well-known', async () => {
    const base = makeGatewayConfig();
    const config = makeGatewayConfig({
      payments: {
        x402: {
          ...(base.payments.x402 as NonNullable<typeof base.payments.x402>),
          rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/SUPER-SECRET-ALCHEMY-KEY',
        },
      },
    });
    const gateway = await buildGateway({ config });
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('SUPER-SECRET-ALCHEMY-KEY');
    expect(res.payload).not.toContain('alchemy.com');
    expect(res.json().payments.x402.rpcUrl).toBeUndefined();
    // What a payer actually needs is still there.
    expect(res.json().payments.x402.network).toBeDefined();
    expect(res.json().payments.x402.asset).toBeDefined();
    expect(res.json().payments.x402.payTo).toBeDefined();
  });

  it('GET /api/resources lists resources without leaking backend header secrets', async () => {
    const config = makeGatewayConfig();
    const withSecretHeader = {
      ...config,
      resources: config.resources.map((r) =>
        r.id === 'market_report'
          ? {
              ...r,
              handler: {
                ...r.handler,
                headers: { authorization: 'Bearer super-secret-backend-key' },
              },
            }
          : r,
      ),
    };
    const gateway = await buildGateway({ config: withSecretHeader });
    const res = await gateway.server.inject({ method: 'GET', url: '/api/resources' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('super-secret-backend-key');
    const body = res.json();
    expect(body.resources.map((r: { id: string }) => r.id).sort()).toEqual([
      'market_report',
      'mcp_only',
      'weather_basic',
    ]);
  });

  it('invokes a free resource and returns the backend body', async () => {
    const backend = createFakeBackend(async () => ({
      status: 200,
      headers: {},
      body: { city: 'Berlin', tempC: 18 },
      durationMs: 3,
    }));
    const gateway = await buildGateway({ backend });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'Berlin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ city: 'Berlin', tempC: 18 });
  });

  it('the invoke route still gets normal JSON body parsing with an HttpProtocolAdapter mounted alongside it (content-type-parser encapsulation regression)', async () => {
    // Guards the exact-match no-op parsers added for the MCP content-type
    // fix: they're registered inside the adapter's own encapsulated plugin
    // and must not leak out and break the main server's JSON body parsing.
    const backend = createFakeBackend(async () => ({
      status: 200,
      headers: {},
      body: { city: 'Paris', tempC: 22 },
      durationMs: 1,
    }));
    const adapter = createFakeHttpAdapter({ mountPath: '/mcp' });
    const gateway = await buildGateway({ backend, protocolAdapters: [adapter] });

    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      headers: { 'content-type': 'application/json' },
      payload: { city: 'Paris' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ city: 'Paris', tempC: 22 });

    const mcpRes = await gateway.server.inject({ method: 'GET', url: '/mcp' });
    expect(mcpRes.statusCode).toBe(200);
  });

  it('invoking a paid resource with no proof returns 402 with a PaymentRequiredEnvelope', async () => {
    const gateway = await buildGateway({ paymentProviders: [createFakePaymentProvider()] });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.status).toBe('payment-required');
    expect(body.code).toBe('PAYMENT_REQUIRED');
    expect(body.payment.amount).toBe('0.01');
    expect(res.headers[PAYMENT_RESPONSE_HEADER]).toBeUndefined();
  });

  it('invoking a paid resource with a valid proof returns 200 and sets X-PAYMENT-RESPONSE', async () => {
    const gateway = await buildGateway({ paymentProviders: [createFakePaymentProvider()] });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof-payload' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const header = res.headers[PAYMENT_RESPONSE_HEADER];
    expect(typeof header).toBe('string');
    const decoded = JSON.parse(Buffer.from(header as string, 'base64').toString('utf8'));
    expect(decoded.status).toBe('settled');
  });

  it("derives the payment method from the resource's paymentMethods instead of hard-coding x402", async () => {
    const gateway = await buildGateway({ paymentProviders: [createFakePaymentProvider()] });
    const captured = spyOnPipelineExecute(gateway);

    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke', // paymentMethods: ['x402']
      headers: { [PAYMENT_HEADER]: 'proof-payload' },
      payload: {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.payment).toEqual({ method: 'x402', payload: 'proof-payload' });
  });

  it('drops an X-PAYMENT proof for a resource with no configured payment methods rather than inventing a rail', async () => {
    const gateway = await buildGateway();
    const captured = spyOnPipelineExecute(gateway);

    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke', // paymentMethods: []
      headers: { [PAYMENT_HEADER]: 'stray-proof' },
      payload: { city: 'Berlin' },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.payment).toBeUndefined();
  });

  it('returns RESOURCE_NOT_FOUND for an unknown resource id', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/does-not-exist/invoke',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns RESOURCE_NOT_FOUND for a resource not exposed via http', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/mcp_only/invoke',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns INPUT_INVALID (400) for input that fails the resource schema', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INPUT_INVALID');
  });

  it('maps a backend error to 502', async () => {
    const backend = createFakeBackend(async () => {
      const { CommerceError } = await import('../../../src/core/index.js');
      throw new CommerceError('BACKEND_ERROR', 'upstream exploded');
    });
    const gateway = await buildGateway({ backend });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'X' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('BACKEND_ERROR');
  });

  it('a backend failure after settlement sets X-PAYMENT-RESPONSE and tells the buyer the payment settled', async () => {
    const backend = createFakeBackend(async () => {
      const { CommerceError } = await import('../../../src/core/index.js');
      throw new CommerceError('BACKEND_ERROR', 'upstream exploded after payment', {
        details: { status: 500 },
      });
    });
    const gateway = await buildGateway({
      backend,
      paymentProviders: [createFakePaymentProvider()],
    });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof' },
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('BACKEND_ERROR');

    const header = res.headers[PAYMENT_RESPONSE_HEADER];
    expect(typeof header).toBe('string');
    const decoded = JSON.parse(Buffer.from(header as string, 'base64').toString('utf8'));
    expect(decoded.status).toBe('settled');
    expect(decoded.externalReference).toBeDefined();
  });

  it('does not set X-PAYMENT-RESPONSE on an ordinary backend error with no settlement in scope (control)', async () => {
    const backend = createFakeBackend(async () => {
      const { CommerceError } = await import('../../../src/core/index.js');
      throw new CommerceError('BACKEND_ERROR', 'upstream exploded');
    });
    const gateway = await buildGateway({ backend });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'X' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.headers[PAYMENT_RESPONSE_HEADER]).toBeUndefined();
  });

  it('maps a backend timeout to 504', async () => {
    const backend = createFakeBackend(async () => {
      const { CommerceError } = await import('../../../src/core/index.js');
      throw new CommerceError('BACKEND_TIMEOUT', 'too slow');
    });
    const gateway = await buildGateway({ backend });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'X' },
    });
    expect(res.statusCode).toBe(504);
  });

  it('maps a rejected payment verification to 402 PAYMENT_INVALID', async () => {
    const provider = createFakePaymentProvider({
      verify: async () => ({
        status: 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        rejectionReason: 'bad-sig',
      }),
    });
    const gateway = await buildGateway({ paymentProviders: [provider] });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof' },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PAYMENT_INVALID');
  });

  it('maps a settlement failure to 502 PAYMENT_SETTLEMENT_FAILED', async () => {
    const provider = createFakePaymentProvider({
      settle: async () => ({
        status: 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
      }),
    });
    const gateway = await buildGateway({ paymentProviders: [provider] });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof' },
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('PAYMENT_SETTLEMENT_FAILED');
  });

  it('maps PAYMENT_PROVIDER_UNAVAILABLE (no matching provider) to 503', async () => {
    const gateway = await buildGateway({ paymentProviders: [] });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });

  it('a replayed payment maps to 409 PAYMENT_REPLAYED', async () => {
    const provider = createFakePaymentProvider();
    const gateway = await buildGateway({ paymentProviders: [provider] });
    const first = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof' },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const second = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof' },
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('PAYMENT_REPLAYED');
  });

  it('GET /api/receipts and /api/events are closed (404) with no adminToken configured', async () => {
    const gateway = await buildGateway();
    const receipts = await gateway.server.inject({ method: 'GET', url: '/api/receipts' });
    expect(receipts.statusCode).toBe(404);
    const events = await gateway.server.inject({ method: 'GET', url: '/api/events' });
    expect(events.statusCode).toBe(404);
    const stream = await gateway.server.inject({ method: 'GET', url: '/api/events/stream' });
    expect(stream.statusCode).toBe(404);
  });

  it('GET /api/receipts and /api/events require the admin token once configured, and reject a wrong one', async () => {
    const config = makeGatewayConfig({
      server: { ...makeGatewayConfig().server, adminToken: ADMIN_TOKEN },
    });
    const gateway = await buildGateway({ config });
    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'X' },
    });

    const noAuth = await gateway.server.inject({ method: 'GET', url: '/api/receipts' });
    expect(noAuth.statusCode).toBe(401);

    const wrongToken = await gateway.server.inject({
      method: 'GET',
      url: '/api/receipts',
      headers: adminHeaders('not-the-token'),
    });
    expect(wrongToken.statusCode).toBe(401);

    const receipts = await gateway.server.inject({
      method: 'GET',
      url: '/api/receipts?limit=10',
      headers: adminHeaders(ADMIN_TOKEN),
    });
    expect(receipts.statusCode).toBe(200);
    expect(receipts.json().receipts).toHaveLength(1);

    const events = await gateway.server.inject({
      method: 'GET',
      url: '/api/events?limit=10',
      headers: adminHeaders(ADMIN_TOKEN),
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.length).toBeGreaterThan(0);
  });

  it('rejects a foreign Origin with 403 on any route, admin or not', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets CORS headers only for an allowlisted Origin, and completes an OPTIONS preflight for it', async () => {
    const config = makeGatewayConfig({
      server: { ...makeGatewayConfig().server, allowedOrigins: ['http://dashboard.local'] },
    });
    const gateway = await buildGateway({ config });

    const res = await gateway.server.inject({
      method: 'GET',
      url: '/api/resources',
      headers: { origin: 'http://dashboard.local' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://dashboard.local');

    const preflight = await gateway.server.inject({
      method: 'OPTIONS',
      url: '/api/resources',
      headers: { origin: 'http://dashboard.local' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://dashboard.local');
  });

  it('sends no CORS header at all when the request carries no Origin (agent/MCP traffic)', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it('rejects a Host header that does not match publicBaseUrl or a loopback alias', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'attacker-controlled.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts 127.0.0.1 as Host even when publicBaseUrl says localhost (loopback alias)', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:8080' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /ready is 503 when store.health() itself throws, without leaking the raw error message', async () => {
    const store = createFakeStore();
    store.health = async () => {
      throw new Error("EACCES: permission denied, access '/workspace/data/receipts.sqlite'");
    };
    const gateway = await buildGateway({ store });
    const res = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().store.status).toBe('fail');
    expect(res.json().store.detail).toBe('store-unreachable');
    expect(res.payload).not.toContain('/workspace/data/receipts.sqlite');
    expect(res.payload).not.toContain('EACCES');
  });

  it('GET /ready reports a fixed vocabulary detail when store.health() returns fail with a raw message', async () => {
    const store = createFakeStore();
    store.health = async () => ({
      status: 'fail',
      detail: 'internal filesystem path /var/secret/db.sqlite is not writable',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const gateway = await buildGateway({ store });
    const res = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().store.detail).toBe('store-unwritable');
    expect(res.payload).not.toContain('/var/secret/db.sqlite');
  });

  it('accepts a numeric limit and clamps a non-numeric one to unlimited', async () => {
    const config = makeGatewayConfig({
      server: { ...makeGatewayConfig().server, adminToken: ADMIN_TOKEN },
    });
    const gateway = await buildGateway({ config });
    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'X' },
    });
    await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/weather_basic/invoke',
      payload: { city: 'Y' },
    });

    const limited = await gateway.server.inject({
      method: 'GET',
      url: '/api/receipts?limit=1',
      headers: adminHeaders(ADMIN_TOKEN),
    });
    expect(limited.json().receipts).toHaveLength(1);

    const garbage = await gateway.server.inject({
      method: 'GET',
      url: '/api/receipts?limit=not-a-number',
      headers: adminHeaders(ADMIN_TOKEN),
    });
    expect(garbage.json().receipts).toHaveLength(2);

    const none = await gateway.server.inject({
      method: 'GET',
      url: '/api/receipts',
      headers: adminHeaders(ADMIN_TOKEN),
    });
    expect(none.json().receipts).toHaveLength(2);
  });

  it('rejects a non-positive limit with INPUT_INVALID rather than returning the entire table', async () => {
    const config = makeGatewayConfig({
      server: { ...makeGatewayConfig().server, adminToken: ADMIN_TOKEN },
    });
    const gateway = await buildGateway({ config });

    for (const bad of ['-1', '0']) {
      const res = await gateway.server.inject({
        method: 'GET',
        url: `/api/receipts?limit=${bad}`,
        headers: adminHeaders(ADMIN_TOKEN),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INPUT_INVALID');
    }

    const eventsRes = await gateway.server.inject({
      method: 'GET',
      url: '/api/events?limit=-5',
      headers: adminHeaders(ADMIN_TOKEN),
    });
    expect(eventsRes.statusCode).toBe(400);
  });

  it('.well-known shows a remote facilitator URL (never signerPrivateKey) and handles no x402 config', async () => {
    const configWithRemote = makeGatewayConfig({
      payments: {
        x402: {
          enabled: true,
          network: 'eip155:84532',
          rpcUrl: 'http://127.0.0.1:8545',
          asset: '0x1111111111111111111111111111111111111111',
          assetName: 'MockUSDC',
          assetVersion: '2',
          assetDecimals: 6,
          payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          maxTimeoutSeconds: 120,
          facilitator: { mode: 'remote', url: 'https://facilitator.example.com' },
        },
      },
    });
    const gateway = await buildGateway({ config: configWithRemote });
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.json().payments.x402.facilitator).toEqual({
      mode: 'remote',
      url: 'https://facilitator.example.com',
    });

    const noPaymentsGateway = await buildGateway({ config: makeGatewayConfig({ payments: {} }) });
    const res2 = await noPaymentsGateway.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });
    expect(res2.json().payments.x402).toBeUndefined();
  });

  it('createGateway works end to end with no injected logger/clock/ids/backend (real defaults)', async () => {
    const { createGateway } = await import('../../../src/gateway/server.js');
    const gateway = await createGateway({
      config: makeGatewayConfig({ resources: [] }),
      store: createFakeStore(),
      paymentProviders: [],
      protocolAdapters: [],
    });
    gateways.push(gateway);
    const res = await gateway.server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('one failing adapter does not prevent the server from starting or other routes from working', async () => {
    const badAdapter = createFakeProtocolAdapter({
      name: 'http',
      start: async () => {
        throw new Error('boom: cannot bind');
      },
    });
    const goodAdapter = createFakeHttpAdapter({ mountPath: '/mcp' });
    const gateway = await buildGateway({ protocolAdapters: [badAdapter, goodAdapter] });

    // The server started at all — health responds.
    const health = await gateway.server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    // Readiness reflects the failed adapter.
    const ready = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().adapters.some((a: { status: string }) => a.status === 'fail')).toBe(true);

    // The good adapter is still mounted and reachable.
    const mounted = await gateway.server.inject({ method: 'GET', url: '/mcp' });
    expect(mounted.statusCode).toBe(200);
    expect(mounted.payload).toBe('fake-adapter-response');
  });

  it('rejects a foreign Origin at /mcp before it reaches the adapter', async () => {
    const adapter = createFakeHttpAdapter({ mountPath: '/mcp' });
    const gateway = await buildGateway({ protocolAdapters: [adapter] });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'https://evil.example' },
      payload: '{"jsonrpc":"2.0"}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.payload).not.toBe('fake-adapter-response');
  });

  it('mounts an HttpProtocolAdapter at its mountPath and passes the raw request through', async () => {
    const adapter = createFakeHttpAdapter({ mountPath: '/mcp' });
    const gateway = await buildGateway({ protocolAdapters: [adapter] });
    const res = await gateway.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: '{"jsonrpc":"2.0"}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('fake-adapter-response');
  });

  it('listen() starts a real server and close() stops adapters and the server', async () => {
    const stopped: string[] = [];
    const adapter = createFakeProtocolAdapter({
      stop: async () => {
        stopped.push('adapter');
      },
    });
    const gateway = await buildGateway({ protocolAdapters: [adapter] });
    const { url } = await gateway.listen();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);

    await gateway.close();
    expect(stopped).toEqual(['adapter']);
    gateways = gateways.filter((g) => g !== gateway);
  });

  it('emits events over SSE for a live request', async () => {
    const config = makeGatewayConfig({
      server: { ...makeGatewayConfig().server, adminToken: ADMIN_TOKEN },
    });
    const gateway = await buildGateway({ config });
    const { url } = await gateway.listen();

    const chunks: string[] = [];
    let resolveConnected: () => void = () => {};
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });

    const req = http.get(
      `${url}/api/events/stream`,
      { headers: adminHeaders(ADMIN_TOKEN) },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          if (chunk.includes('connected')) resolveConnected();
        });
      },
    );
    await connected;

    await fetch(`${url}/api/resources/weather_basic/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ city: 'Berlin' }),
    });

    await vi.waitFor(
      () => {
        expect(chunks.join('')).toContain('resource.delivered');
      },
      { timeout: 2000 },
    );

    // invariant, checked on the real wire (split 3): every
    // frame is a bare `data:...` line, never a named `event:...` line. A
    // named frame only reaches an EventSource listener added via
    // addEventListener(type,...), never the default onmessage — and since
    // no browser EventSource can authenticate against this route any more
    // (see the test below), onmessage is the only handler a real dashboard
    // can use, so this property is load-bearing even though nothing here
    // drives an actual EventSource.
    const raw = chunks.join('');
    expect(raw).not.toMatch(/^event:/m);
    expect(raw).toMatch(/^data: .*resource\.delivered/m);

    req.destroy();
    await gateway.close();
    gateways = gateways.filter((g) => g !== gateway);
  });

  it(
    'does not accept the admin token as a query parameter on any operator route ' +
      '(removed; see SECURITY.md: the query-token exception was ' +
      'documented as removed while the code still honoured it)',
    async () => {
      const config = makeGatewayConfig({
        server: { ...makeGatewayConfig().server, adminToken: ADMIN_TOKEN },
      });
      const gateway = await buildGateway({ config });
      const { url } = await gateway.listen();

      // Configured token: a query token must be REJECTED (401), not
      // silently accepted, on every operator route including the SSE one.
      for (const path of ['/api/events/stream', '/api/receipts', '/api/events']) {
        const res = await fetch(`${url}${path}?adminToken=${ADMIN_TOKEN}`);
        expect(res.status, `${path}?adminToken=... should 401`).toBe(401);
      }

      // The header path must still work — the removal must not have taken
      // the whole route's authentication with it.
      const authed = await fetch(`${url}/api/events/stream`, {
        headers: adminHeaders(ADMIN_TOKEN),
      });
      expect(authed.status).toBe(200);
      authed.body?.cancel();

      await gateway.close();
      gateways = gateways.filter((g) => g !== gateway);
    },
  );

  it('no adminToken configured -> a query token still 404s, same as no token at all', async () => {
    const gateway = await buildGateway({ config: makeGatewayConfig() });
    const { url } = await gateway.listen();

    const res = await fetch(`${url}/api/events/stream?adminToken=${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);

    await gateway.close();
    gateways = gateways.filter((g) => g !== gateway);
  });

  it('a real EventSource can never reach the gated SSE route, in either posture ' +
    '(do not "fix" this by reopening the route — ' +
    'see the frame-format assertion above for the invariant this test used ' +
    'to protect via a real EventSource, back when the query-token exception ' +
    'was the only way a header-less client could authenticate)', async () => {
    // Token configured: EventSource cannot send the Authorization header,
    // so the connection gets a 401 and never opens.
    const withToken = makeGatewayConfig({
      server: { ...makeGatewayConfig().server, adminToken: ADMIN_TOKEN },
    });
    const gatewayWithToken = await buildGateway({ config: withToken });
    const urlWithToken = (await gatewayWithToken.listen()).url;

    // No token configured: the operator routes fail closed (404) rather
    // than open — decision, restated by the earlier README/
    // SECURITY.md fix — so this posture is no more reachable than the
    // token-configured one.
    const withoutToken = makeGatewayConfig();
    const gatewayWithoutToken = await buildGateway({ config: withoutToken });
    const urlWithoutToken = (await gatewayWithoutToken.listen()).url;

    for (const url of [urlWithToken, urlWithoutToken]) {
      const clientScript = `
          const es = new EventSource(process.argv[1]);
          let opened = false;
          es.onopen = () => { opened = true; process.stdout.write('OPEN\\n'); };
          setTimeout(() => {
            process.stdout.write('DONE opened=' + opened + '\\n');
            es.close();
            process.exit(0);
          }, 800);
        `;
      const child = spawn(
        process.execPath,
        ['--experimental-eventsource', '-e', clientScript, `${url}/api/events/stream`],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
      expect(output, `EventSource against ${url}`).not.toContain('OPEN');
    }

    await gatewayWithToken.close();
    await gatewayWithoutToken.close();
    gateways = gateways.filter((g) => g !== gatewayWithToken && g !== gatewayWithoutToken);
  }, 10_000);
});
