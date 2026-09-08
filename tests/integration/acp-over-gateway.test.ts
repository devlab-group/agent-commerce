/**
 * ACP the way a client reaches it: over a real `createGateway()` Fastify
 * instance with a real `createAcpAdapter()` mounted.
 *
 * An adapter that works when driven directly but is unreachable through the
 * gateway is not a protocol, and only a test that traverses the mount can tell
 * the two apart - the body arriving intact through the mount's content-type
 * suppression is exactly the thing unit tests cannot see.
 *
 * Fakes: ReceiptStore and BackendExecutor. Everything else is the real thing.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../src/config/index.js';
import type { BackendExecutor } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createA2aAdapter } from '../../src/protocols/a2a/index.js';
import { ACP_SPEC_VERSION, ACP_WELL_KNOWN_PATH } from '../../src/protocols/acp/constants.js';
import { createAcpAdapter } from '../../src/protocols/acp/index.js';
import { createMcpAdapter } from '../../src/protocols/mcp/index.js';
import { createFakeStore } from '../unit/gateway/helpers.js';

process.env['NODE_ENV'] = 'test';

const TOKEN = 'acp-integration-token';

const EXAMPLES = JSON.parse(
  readFileSync('tests/fixtures/acp/2026-04-17/examples.agentic_checkout.json', 'utf8'),
) as Record<string, Record<string, unknown>>;

const OPERATIONS = {
  createCheckoutSession: 'acp_checkout_create',
  updateCheckoutSession: 'acp_checkout_update',
  getCheckoutSession: 'acp_checkout_get',
  completeCheckoutSession: 'acp_checkout_complete',
  cancelCheckoutSession: 'acp_checkout_cancel',
} as const;

let gateway: GatewayInstance | undefined;

afterEach(async () => {
  await gateway?.close().catch(() => {});
  gateway = undefined;
  backendCalls.length = 0;
});

function checkoutResources(): GatewayConfig['resources'] {
  return Object.values(OPERATIONS).map((id) => ({
    id,
    name: id,
    handler: { type: 'http' as const, method: 'POST' as const, url: `http://backend.local/${id}` },
    pricing: { type: 'free' as const },
    exposedVia: ['acp' as const],
    paymentMethods: [],
  }));
}

function config(acpEnabled: boolean): GatewayConfig {
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
      a2a: { enabled: false, mountPath: '/a2a' },
      acp: acpEnabled
        ? {
            enabled: true,
            mountPath: '/acp',
            auth: { type: 'bearer', token: TOKEN },
            idempotency: { path: ':memory:', retentionHours: 24 },
            checkout: { operations: OPERATIONS },
          }
        : { enabled: false, mountPath: '/acp' },
    },
    resources: [
      {
        id: 'weather_basic',
        name: 'Basic Weather',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
        pricing: { type: 'free' },
        exposedVia: ['http', 'mcp'],
        paymentMethods: [],
      },
      ...(acpEnabled ? checkoutResources() : []),
    ],
    payments: {},
  };
}

const backendCalls: { resourceId: string; input: unknown }[] = [];

/** Answers every checkout call with the snapshot's own example documents. */
const backend: BackendExecutor = {
  async call(handler, request) {
    backendCalls.push({ resourceId: request.resourceId, input: request.input });
    if (handler.url.endsWith(OPERATIONS.createCheckoutSession)) {
      return {
        status: 201,
        body: EXAMPLES['create_checkout_session_response'],
        headers: { 'set-cookie': 'merchant_session=leak-me' },
        durationMs: 1,
      };
    }
    if (handler.url.endsWith(OPERATIONS.completeCheckoutSession)) {
      return {
        status: 200,
        body: EXAMPLES['complete_checkout_session_response'],
        headers: {},
        durationMs: 1,
      };
    }
    return {
      status: 200,
      body: EXAMPLES['get_checkout_session_response'],
      headers: {},
      durationMs: 1,
    };
  },
};

async function startGateway(acpEnabled = true): Promise<GatewayInstance> {
  const cfg = config(acpEnabled);
  const acp = cfg.protocols.acp;
  gateway = await createGateway({
    config: cfg,
    store: createFakeStore(),
    paymentProviders: [],
    protocolAdapters: [
      createMcpAdapter(),
      ...(acp.enabled
        ? [
            createAcpAdapter({
              mountPath: acp.mountPath,
              token: acp.auth.token,
              operations: acp.checkout.operations,
              idempotency: acp.idempotency,
            }),
          ]
        : []),
    ],
    backend,
  });
  return gateway;
}

function acpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'api-version': ACP_SPEC_VERSION,
    'content-type': 'application/json',
    'idempotency-key': 'idem-integration-1',
    ...extra,
  };
}

const CREATE_BODY = { line_items: [{ id: 'item_123' }], currency: 'usd', capabilities: {} };

describe('ACP over the gateway', () => {
  it('serves discovery at the specification-fixed path, unauthenticated', async () => {
    const gw = await startGateway();
    const res = await gw.server.inject({ method: 'GET', url: ACP_WELL_KNOWN_PATH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.json()).toMatchObject({
      protocol: { name: 'acp', version: ACP_SPEC_VERSION },
      api_base_url: 'http://localhost:8080/acp',
      transports: ['rest'],
      capabilities: { services: ['checkout'] },
    });
  });

  // The mount suppresses Fastify's body parsers so an adapter can read the
  // stream itself. If that ever regresses, the adapter reads an empty body and
  // every checkout fails to parse - which no unit test can see.
  it('receives a POST body intact through the mount', async () => {
    const gw = await startGateway();
    const res = await gw.server.inject({
      method: 'POST',
      url: '/acp/checkout_sessions',
      headers: acpHeaders(),
      payload: JSON.stringify(CREATE_BODY),
    });

    expect(res.statusCode).toBe(201);
    expect(backendCalls).toEqual([
      { resourceId: OPERATIONS.createCheckoutSession, input: { body: CREATE_BODY } },
    ]);
  });

  it('routes each operation to its own resource', async () => {
    const gw = await startGateway();
    await gw.server.inject({
      method: 'GET',
      url: '/acp/checkout_sessions/cs_1',
      headers: { authorization: `Bearer ${TOKEN}`, 'api-version': ACP_SPEC_VERSION },
    });
    await gw.server.inject({
      method: 'POST',
      url: '/acp/checkout_sessions/cs_1/complete',
      headers: acpHeaders(),
      payload: JSON.stringify(EXAMPLES['complete_checkout_session_request']),
    });

    expect(backendCalls.map((call) => call.resourceId)).toEqual([
      OPERATIONS.getCheckoutSession,
      OPERATIONS.completeCheckoutSession,
    ]);
  });

  it('never proxies merchant response headers', async () => {
    const gw = await startGateway();
    const res = await gw.server.inject({
      method: 'POST',
      url: '/acp/checkout_sessions',
      headers: acpHeaders(),
      payload: JSON.stringify(CREATE_BODY),
    });

    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['idempotency-key']).toBe('idem-integration-1');
  });

  it('rejects an unauthenticated checkout without calling the backend', async () => {
    const gw = await startGateway();
    const res = await gw.server.inject({
      method: 'POST',
      url: '/acp/checkout_sessions',
      headers: { 'content-type': 'application/json', 'api-version': ACP_SPEC_VERSION },
      payload: JSON.stringify(CREATE_BODY),
    });

    expect(res.statusCode).toBe(401);
    expect(backendCalls).toEqual([]);
  });
});

describe('ACP disabled', () => {
  it('serves no ACP route at all', async () => {
    const gw = await startGateway(false);

    const discovery = await gw.server.inject({ method: 'GET', url: ACP_WELL_KNOWN_PATH });
    const checkout = await gw.server.inject({
      method: 'POST',
      url: '/acp/checkout_sessions',
      headers: acpHeaders(),
      payload: JSON.stringify(CREATE_BODY),
    });

    expect(discovery.statusCode).toBe(404);
    expect(checkout.statusCode).toBe(404);
  });

  it('leaves the other protocols untouched', async () => {
    const gw = await startGateway(false);
    const health = await gw.server.inject({ method: 'GET', url: '/health' });
    const wellKnown = await gw.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });

    expect(health.statusCode).toBe(200);
    expect(wellKnown.json()).toMatchObject({
      protocols: { mcp: { enabled: true }, acp: { enabled: false } },
    });
  });
});

describe('ACP in the gateway discovery document', () => {
  it('reports the adapter and its mount, and no credential', async () => {
    const gw = await startGateway();
    const res = await gw.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    const body = res.json<{
      protocols: Record<string, unknown>;
      adapters: { name: string; status: string; supportedSpec: string; unsupported?: string[] }[];
    }>();

    expect(body.protocols['acp']).toEqual({ enabled: true, mountPath: '/acp' });
    const acp = body.adapters.find((adapter) => adapter.name === 'acp');
    expect(acp).toMatchObject({ status: 'experimental', supportedSpec: ACP_SPEC_VERSION });
    expect(acp?.unsupported).toContain('delegate_payment');

    // The bearer token, the idempotency database and the operation-to-resource
    // mapping are configuration, not public protocol facts.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('idempotency');
    expect(serialized).not.toContain(OPERATIONS.createCheckoutSession);
  });
});

describe('ACP adapter isolation', () => {
  it('keeps the other protocols serving when the ACP adapter fails to start', async () => {
    const broken = createAcpAdapter({
      mountPath: '/acp',
      token: TOKEN,
      operations: OPERATIONS,
      idempotency: { path: ':memory:', retentionHours: 24 },
      // A currency ACP's schema rejects: the adapter refuses to publish a
      // non-conformant discovery document and fails its own start.
      discovery: { supportedCurrencies: ['US Dollars'] },
    });

    gateway = await createGateway({
      config: config(true),
      store: createFakeStore(),
      paymentProviders: [],
      protocolAdapters: [createMcpAdapter(), createA2aAdapter(), broken],
      backend,
    });

    const health = await gateway.server.inject({ method: 'GET', url: '/health' });
    const mcp = await gateway.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const acp = await gateway.server.inject({
      method: 'POST',
      url: '/acp/checkout_sessions',
      headers: acpHeaders(),
      payload: JSON.stringify(CREATE_BODY),
    });

    expect(health.statusCode).toBe(200);
    expect(mcp.statusCode).toBeLessThan(500);
    // The gateway's existing policy for a start failure: the adapter is not
    // mounted at all, so its routes do not exist rather than half-answering.
    expect(acp.statusCode).toBe(404);

    // It is still reported, with failing health - a silently missing protocol
    // is how a broken deployment looks healthy.
    const wellKnown = await gateway.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });
    const acpAdapter = wellKnown
      .json<{ adapters: { name: string; health: { status: string } }[] }>()
      .adapters.find((adapter) => adapter.name === 'acp');
    expect(acpAdapter?.health.status).toBe('fail');
  });
});
