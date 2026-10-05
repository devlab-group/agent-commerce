import { afterEach, describe, expect, it, vi } from 'vitest';

// Quiet output, and no pino-pretty worker thread for each of the many Fastify
// instances this file creates
process.env['NODE_ENV'] = 'test';

import type {
  BackendExecutor,
  CanonicalRequest,
  Clock,
  ExecutionPipeline,
  IdGenerator,
  Logger,
} from '../../../src/core';
import {
  DELIVERY_SUMMARY_META_KEY,
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from '../../../src/core';
import { MOUNT_BODY_LIMIT_BYTES } from '../../../src/gateway/adapters';
import { createGateway, type GatewayInstance } from '../../../src/gateway/server';
import { PACKAGE_VERSION } from '../../../src/version';
import {
  createFakeHttpAdapter,
  createFakePaymentProvider,
  createFakeProtocolAdapter,
  createFakeStore,
  makeGatewayConfig,
} from './helpers';

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
 * Wraps `execute()` on the gateway's own pipeline instance, the object the
 * invoke route closed over, to assert on the exact `CanonicalRequest` the
 * route built
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

// Give the fake x402 provider a challenge envelope for refusal responses
function x402Provider(overrides: Parameters<typeof createFakePaymentProvider>[0] = {}) {
  return createFakePaymentProvider({
    createRequirement: async (ctx) => ({
      id: 'requirement-1',
      requestId: ctx.requestId,
      resourceId: ctx.resource.id,
      provider: 'x402',
      amount: ctx.amount,
      currency: ctx.currency,
      destination: '0xMERCHANT',
      network: 'eip155:84532',
      challenge: {
        provider: 'x402',
        version: '2',
        accepts: [{ scheme: 'exact' }],
        envelope: { x402Version: 2, accepts: [{ scheme: 'exact' }] },
      },
    }),
    ...overrides,
  });
}

function decodeHeader(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('string');
  return JSON.parse(Buffer.from(value as string, 'base64').toString('utf8'));
}

async function invokePaid(gateway: GatewayInstance) {
  return gateway.server.inject({
    method: 'POST',
    url: '/api/resources/market_report/invoke',
    headers: { [PAYMENT_HEADER]: 'proof' },
    payload: {},
  });
}

afterEach(async () => {
  await Promise.all(gateways.map((g) => g.close().catch(() => {})));
  gateways = [];
});

describe('createGateway HTTP surface', () => {
  it('mints the audit request id even when the client sends a well-formed x-request-id', async () => {
    const gateway = await buildGateway();
    const captured = spyOnPipelineExecute(gateway);
    for (let i = 0; i < 2; i++) {
      await gateway.server.inject({
        method: 'POST',
        url: '/api/resources/weather_basic/invoke',
        headers: { 'x-request-id': 'client-flow-abc.123:v2' },
        payload: { city: 'Berlin' },
      });
    }
    // Two flows sending the same client id still get distinct audit keys
    expect(captured).toHaveLength(2);
    expect(captured[0]?.requestId).not.toBe('client-flow-abc.123:v2');
    expect(captured[0]?.requestId).not.toBe(captured[1]?.requestId);
  });

  it('keeps a caller X-Request-Id only as the clientRequestId log binding, and only in its bounded form', async () => {
    const gateway = await buildGateway();
    const child = vi.spyOn(gateway.server.log, 'child');
    for (const id of ['client-flow-abc.123:v2', 'x'.repeat(5000), 'legit-id/../with-slash']) {
      await gateway.server.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': id },
      });
    }
    const bindings = child.mock.calls.map(
      ([binding]) => (binding as Record<string, unknown>)['clientRequestId'],
    );
    expect(bindings).toEqual(['client-flow-abc.123:v2', undefined, undefined]);
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

  it('GET /ready is 503 when a payment provider is unhealthy', async () => {
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
    expect(body.store.name).toBe('fake-store');

    const raw = res.payload;
    expect(raw).not.toContain('TOTALLY_SECRET_KEY');
    expect(raw).not.toContain('signerPrivateKey');
  });

  // These wire identifiers are in deployed clients, so a rename breaks them.
  // The MCP server name, x402 resource URI and local chain name belong to other areas.
  it('publishes the agent-commerce wire identity at /.well-known/agent-commerce', async () => {
    const gateway = await buildGateway();
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.statusCode).toBe(200);
    // The spec names the wire contract and changes only with it, never with the package version
    expect(res.json().gateway).toEqual({
      implementationVersion: PACKAGE_VERSION,
      supportedSpec: 'agent-commerce/v1.0.0',
    });
    expect(DELIVERY_SUMMARY_META_KEY).toBe('agent-commerce/delivery');
  });

  it('serves /.well-known adapter health from the memoized readiness probe, detail dropped', async () => {
    let healthCalls = 0;
    const adapter = createFakeProtocolAdapter({
      health: async () => {
        healthCalls += 1;
        return {
          status: 'warn',
          detail: 'internal-host:5432',
          checkedAt: '2026-01-01T00:00:00.000Z',
        };
      },
    });
    const gateway = await buildGateway({ protocolAdapters: [adapter] });

    await gateway.server.inject({ method: 'GET', url: '/ready' });
    const first = await gateway.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });
    await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });

    // The fake clock moves 1 ms per read, so every call lands inside one TTL window
    expect(healthCalls).toBe(1);
    expect(first.json().adapters[0].health).toEqual({
      status: 'warn',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(first.payload).not.toContain('internal-host');
  });

  it('never publishes rpcUrl on /.well-known', async () => {
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
    // What a payer needs is still there
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

  it('parses a JSON, plain-text or empty invoke body and refuses any other content type before the pipeline', async () => {
    const gateway = await buildGateway();
    const captured = spyOnPipelineExecute(gateway);
    const invoke = (headers: Record<string, string>, payload?: string) =>
      gateway.server.inject({
        method: 'POST',
        url: '/api/resources/weather_basic/invoke',
        headers,
        ...(payload !== undefined ? { payload } : {}),
      });

    expect(
      (await invoke({ 'content-type': 'application/json' }, '{"city":"Berlin"}')).statusCode,
    ).toBe(200);
    // A string fails the object schema, but only after reaching the pipeline
    expect((await invoke({ 'content-type': 'text/plain' }, 'Berlin')).json().code).toBe(
      'INPUT_INVALID',
    );
    expect((await invoke({})).json().code).toBe('INPUT_INVALID');
    expect(captured.map((request) => request.input)).toEqual([{ city: 'Berlin' }, 'Berlin', {}]);

    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/octet-stream',
    ]) {
      const res = await invoke({ 'content-type': contentType }, 'city=Berlin');
      expect(res.statusCode, contentType).toBe(415);
    }
    expect(captured).toHaveLength(3);
  });

  it('refuses an invoke body over the 256 KiB limit with 413 before the pipeline', async () => {
    const gateway = await buildGateway();
    const captured = spyOnPipelineExecute(gateway);
    const invoke = (city: string) =>
      gateway.server.inject({
        method: 'POST',
        url: '/api/resources/weather_basic/invoke',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ city }),
      });

    const oversized = await invoke('x'.repeat(MOUNT_BODY_LIMIT_BYTES));
    expect(oversized.statusCode).toBe(413);
    expect(captured).toHaveLength(0);

    // Control: a body just under the limit is parsed and executed
    const underLimit = await invoke('x'.repeat(MOUNT_BODY_LIMIT_BYTES - 64));
    expect(underLimit.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it('the invoke route still gets normal JSON body parsing with an HttpProtocolAdapter mounted alongside it (content-type-parser encapsulation regression)', async () => {
    // The adapter mount's no-op content-type parsers live in its encapsulated
    // plugin and must not break the main server's JSON body parsing
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

  it('invoking a paid resource with no proof returns 402 with the PAYMENT-REQUIRED challenge and delivers nothing', async () => {
    const challengeEnvelope = { x402Version: 2, accepts: [{ scheme: 'exact', amount: '10000' }] };
    const provider = createFakePaymentProvider({
      createRequirement: async (ctx) => ({
        id: 'requirement-1',
        requestId: ctx.requestId,
        resourceId: ctx.resource.id,
        provider: 'x402',
        amount: ctx.amount,
        currency: ctx.currency,
        destination: '0xMERCHANT',
        challenge: { provider: 'x402', version: '2', accepts: [], envelope: challengeEnvelope },
      }),
    });
    let backendCalls = 0;
    const backend = createFakeBackend(async () => {
      backendCalls += 1;
      return { status: 200, headers: {}, body: { report: 'paid content' }, durationMs: 1 };
    });
    const gateway = await buildGateway({ backend, paymentProviders: [provider] });

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
    expect(res.payload).not.toContain('paid content');
    expect(backendCalls).toBe(0);
    // x402 v2 clients read the challenge from this header, not the body
    const header = res.headers[PAYMENT_REQUIRED_HEADER];
    expect(JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))).toEqual(
      challengeEnvelope,
    );
    // Each challenge has its own expiry, so none may be served from a cache
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers[PAYMENT_RESPONSE_HEADER]).toBeUndefined();

    // A v1 client's `X-PAYMENT` proof is not read; the challenge names why
    const v1 = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { 'x-payment': 'v1-proof' },
      payload: {},
    });
    expect(v1.statusCode).toBe(402);
    expect(decodeHeader(v1.headers[PAYMENT_REQUIRED_HEADER])).toEqual({
      ...challengeEnvelope,
      error: 'invalid_x402_version',
    });
    expect(backendCalls).toBe(0);

    // Control: the same backend is reachable once a proof is attached
    const paid = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof-payload' },
      payload: {},
    });
    expect(paid.statusCode).toBe(200);
    expect(backendCalls).toBe(1);
  });

  it('returns 200 and a base-unit PAYMENT-RESPONSE for a valid proof', async () => {
    const provider = createFakePaymentProvider({
      settle: async () => ({
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        network: 'eip155:84532',
        payer: '0xBUYER',
        externalReference: 'tx-1',
        metadata: { amountBaseUnits: '10000' },
      }),
    });
    const gateway = await buildGateway({ paymentProviders: [provider] });
    const res = await invokePaid(gateway);
    expect(res.statusCode).toBe(200);
    expect(decodeHeader(res.headers[PAYMENT_RESPONSE_HEADER])).toMatchObject({
      success: true,
      transaction: 'tx-1',
      network: 'eip155:84532',
      payer: '0xBUYER',
      // The x402 settlement amount uses base units
      amount: '10000',
      status: 'settled',
    });
    // Paid responses need private cache control
    expect(res.headers['cache-control']).toBe('private');
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

  it('labels the proof with the rail the pipeline charges through, not the first one declared', async () => {
    // MPP is declared first but has no provider, so both ingress and the
    // pipeline must select x402
    const base = makeGatewayConfig();
    const gateway = await buildGateway({
      config: {
        ...base,
        resources: base.resources.map((resource) =>
          resource.id === 'market_report'
            ? { ...resource, paymentMethods: ['mpp', 'x402'] as const }
            : resource,
        ),
      },
      paymentProviders: [createFakePaymentProvider({ name: 'x402' })],
    });
    const captured = spyOnPipelineExecute(gateway);

    const res = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { [PAYMENT_HEADER]: 'proof-payload' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(captured[0]?.payment).toEqual({ method: 'x402', payload: 'proof-payload' });
    // MCP and A2A read the same ordered registry
    expect(gateway.resources.get('market_report')?.paymentMethods).toEqual(['x402', 'mpp']);
    // The public listing names only rails a provider backs
    const listed = (await gateway.server.inject({ method: 'GET', url: '/api/resources' })).json();
    const report = listed.resources.find((r: { id: string }) => r.id === 'market_report');
    expect(report.paymentMethods).toEqual(['x402']);
  });

  it('drops a proof when no payment rail is configured', async () => {
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
      const { CommerceError } = await import('../../../src/core');
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
      const { CommerceError } = await import('../../../src/core');
      throw new CommerceError('BACKEND_ERROR', 'upstream exploded after payment', {
        details: { status: 500 },
      });
    });
    const store = createFakeStore();
    const gateway = await buildGateway({
      backend,
      store,
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
    expect(decoded).toMatchObject({ success: true, status: 'settled', transaction: 'tx-1' });

    // The ledger shows the purchase as paid and undelivered
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({
      resourceId: 'market_report',
      backendStatus: 500,
      payment: { status: 'settled', externalReference: 'tx-1' },
      metadata: { delivered: false },
    });
    expect(await store.countUndeliveredReceipts()).toBe(1);
  });

  it('does not set X-PAYMENT-RESPONSE on an ordinary backend error with no settlement in scope (control)', async () => {
    const backend = createFakeBackend(async () => {
      const { CommerceError } = await import('../../../src/core');
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
      const { CommerceError } = await import('../../../src/core');
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

  it('returns 402 with a new PAYMENT-REQUIRED and refusal reason', async () => {
    const provider = x402Provider({
      verify: async () => ({
        status: 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        rejectionReason: 'invalid_exact_evm_payload_signature',
      }),
    });
    const gateway = await buildGateway({ paymentProviders: [provider] });
    const res = await invokePaid(gateway);
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PAYMENT_INVALID');
    expect(decodeHeader(res.headers[PAYMENT_REQUIRED_HEADER])).toEqual({
      x402Version: 2,
      accepts: [{ scheme: 'exact' }],
      error: 'invalid_exact_evm_payload_signature',
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 402 and a failed PAYMENT-RESPONSE for refused settlement', async () => {
    const provider = x402Provider({
      settle: async () => ({
        status: 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        network: 'eip155:84532',
        payer: '0xBUYER',
        rejectionReason: 'insufficient_funds',
      }),
    });
    const gateway = await buildGateway({ paymentProviders: [provider] });
    const res = await invokePaid(gateway);
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('PAYMENT_SETTLEMENT_FAILED');
    expect(decodeHeader(res.headers[PAYMENT_RESPONSE_HEADER])).toEqual({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'eip155:84532',
      payer: '0xBUYER',
    });
    // x402 answers a refused settlement with PAYMENT-RESPONSE alone
    expect(res.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 502 and settlement_pending when settlement is unconfirmed', async () => {
    const { CommerceError } = await import('../../../src/core');
    const provider = x402Provider({
      settle: async () => {
        throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'broadcast, not confirmed', {
          details: { transactionHash: '0xabc' },
        });
      },
    });
    const gateway = await buildGateway({ paymentProviders: [provider] });
    const res = await invokePaid(gateway);
    // A 502 avoids inviting another payment while the first may still land
    expect(res.statusCode).toBe(502);
    expect(decodeHeader(res.headers[PAYMENT_RESPONSE_HEADER])).toEqual({
      success: false,
      errorReason: 'settlement_pending',
      transaction: '0xabc',
      network: 'eip155:84532',
    });
    expect(res.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
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

  it('returns 402 and a spent-nonce challenge for a settled replay', async () => {
    const gateway = await buildGateway({ paymentProviders: [x402Provider()] });
    expect((await invokePaid(gateway)).statusCode).toBe(200);

    const replay = await invokePaid(gateway);
    expect(replay.statusCode).toBe(402);
    expect(replay.json().code).toBe('PAYMENT_REPLAYED');
    expect(decodeHeader(replay.headers[PAYMENT_REQUIRED_HEADER])).toMatchObject({
      x402Version: 2,
      error: 'invalid_exact_evm_nonce_already_used',
    });
  });

  it('returns 409 when the first payment attempt is unfinished', async () => {
    const store = createFakeStore();
    store.attempts.set('replay-key-1', {
      id: 'attempt-0',
      requestId: 'req-0',
      resourceId: 'market_report',
      provider: 'x402',
      replayKey: 'replay-key-1',
      status: 'reserved',
      amount: '0.01',
      currency: 'USDC',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const gateway = await buildGateway({ store, paymentProviders: [x402Provider()] });

    const replay = await invokePaid(gateway);
    // No new challenge: the first payment may still settle
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe('PAYMENT_REPLAYED');
    expect(replay.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
  });

  it('GET /api/receipts and /api/events are closed (404) with no adminToken configured', async () => {
    const gateway = await buildGateway();
    const receipts = await gateway.server.inject({ method: 'GET', url: '/api/receipts' });
    expect(receipts.statusCode).toBe(404);
    const events = await gateway.server.inject({ method: 'GET', url: '/api/events' });
    expect(events.statusCode).toBe(404);
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

  it('accepts a numeric limit and ignores a non-numeric one, leaving the store default', async () => {
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
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'none' },
          },
        },
      },
    });
    const gateway = await buildGateway({ config: configWithRemote });
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    // The facilitator URL is never published: like rpcUrl, it can carry a
    // tenant path or an API key
    expect(res.json().payments.x402.facilitator).toEqual({ mode: 'remote' });
    expect(JSON.stringify(res.json())).not.toContain('facilitator.example.com');
    expect(res.json().payments.x402.mode).toBe('testnet');

    const noPaymentsGateway = await buildGateway({ config: makeGatewayConfig({ payments: {} }) });
    const res2 = await noPaymentsGateway.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });
    expect(res2.json().payments.x402).toBeUndefined();
  });

  it('createGateway works end to end with no injected logger/clock/ids/backend (real defaults)', async () => {
    const { createGateway } = await import('../../../src/gateway/server');
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

    // The server started: health responds
    const health = await gateway.server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    // Readiness reflects the failed adapter
    const ready = await gateway.server.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().adapters).toContainEqual({
      name: 'http',
      status: 'fail',
      detail: 'adapter-unreachable',
    });
    // The start error can name a port, host or path, so it stays in the log
    expect(ready.payload).not.toContain('cannot bind');

    // The good adapter is still mounted and reachable
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

  it('does not accept the admin token as a query parameter on any operator route', async () => {
    const config = makeGatewayConfig({
      server: { ...makeGatewayConfig().server, adminToken: ADMIN_TOKEN },
    });
    const gateway = await buildGateway({ config });
    const { url } = await gateway.listen();

    // With a token configured, a query token is rejected (401) on every operator
    // route
    for (const path of ['/api/receipts', '/api/events']) {
      const res = await fetch(`${url}${path}?adminToken=${ADMIN_TOKEN}`);
      expect(res.status, `${path}?adminToken=... should 401`).toBe(401);
    }

    // The header still authenticates
    const authed = await fetch(`${url}/api/events`, { headers: adminHeaders(ADMIN_TOKEN) });
    expect(authed.status).toBe(200);

    await gateway.close();
    gateways = gateways.filter((g) => g !== gateway);
  });

  it('no adminToken configured -> a query token still 404s, same as no token at all', async () => {
    const gateway = await buildGateway({ config: makeGatewayConfig() });
    const { url } = await gateway.listen();

    const res = await fetch(`${url}/api/events?adminToken=${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);

    await gateway.close();
    gateways = gateways.filter((g) => g !== gateway);
  });
});
