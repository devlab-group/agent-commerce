/**
 * Agent Card construction and adapter lifecycle, driven directly. The route
 * itself is exercised over the real gateway in
 * tests/integration/a2a-over-gateway.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createResourceRegistry } from '../../../src/core/execution/index.js';
import type {
  Clock,
  CommerceResource,
  EventSink,
  ExecutionPipeline,
  IdGenerator,
  Logger,
  ProtocolAdapterContext,
  ResourceRegistry,
} from '../../../src/core/index.js';
import { buildAgentCard, endpointUrl } from '../../../src/protocols/a2a/agent-card.js';
import { createA2aAdapter } from '../../../src/protocols/a2a/index.js';
import type { A2aAgentCard } from '../../../src/protocols/a2a/types.js';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

const clock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  nowIso: () => '2026-01-01T00:00:00.000Z',
  monotonicMs: () => 0,
};

function resource(overrides: Partial<CommerceResource> = {}): CommerceResource {
  return {
    id: 'weather_basic',
    name: 'Basic Weather',
    description: 'Current weather for a city.',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
    pricing: { type: 'free' },
    exposedVia: ['a2a'],
    paymentMethods: [],
    ...overrides,
  };
}

const paid = resource({
  id: 'market_report',
  name: 'Premium Market Report',
  description: 'Latest market analysis.',
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  exposedVia: ['a2a'],
  paymentMethods: ['x402'],
});

function context(resources: readonly CommerceResource[]): ProtocolAdapterContext {
  return {
    pipeline: {
      execute: async () => {
        throw new Error('unused in phase 3');
      },
    } as unknown as ExecutionPipeline,
    resources: createResourceRegistry(resources) as ResourceRegistry,
    events: { emit: async () => {} } as EventSink,
    logger: NOOP_LOGGER,
    clock,
    ids: { next: () => 'id' } as IdGenerator,
    publicBaseUrl: 'https://gateway.example.com',
  };
}

async function cardFrom(
  resources: readonly CommerceResource[],
  options: { mountPath?: string } = {},
): Promise<A2aAgentCard> {
  const adapter = createA2aAdapter(options);
  await adapter.start(context(resources));
  const res = await callCardRoute(adapter);
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as A2aAgentCard;
}

/** Drives the fixed route's handler with a minimal fake req/res pair. */
async function callCardRoute(
  adapter: ReturnType<typeof createA2aAdapter>,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  const route = adapter.additionalHttpRoutes[0];
  if (route === undefined) throw new Error('no agent card route declared');
  let body = '';
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return res;
    },
  };
  await route.handleHttp(
    { method } as never,
    res as unknown as Parameters<typeof route.handleHttp>[1],
  );
  return { status, body };
}

describe('A2A agent card', () => {
  it('declares the fixed card path as a GET route', () => {
    const adapter = createA2aAdapter();
    expect(adapter.additionalHttpRoutes).toHaveLength(1);
    expect(adapter.additionalHttpRoutes[0]?.method).toBe('GET');
    expect(adapter.additionalHttpRoutes[0]?.path).toBe('/.well-known/agent-card.json');
  });

  it('publishes only a2a-exposed resources as skills', async () => {
    const card = await cardFrom([
      resource(),
      resource({ id: 'mcp_only', exposedVia: ['mcp'] }),
      paid,
    ]);
    expect(card.skills.map((s) => s.id)).toEqual(['weather_basic', 'market_report']);
  });

  it('uses the canonical resource id as the skill id', async () => {
    const card = await cardFrom([paid]);
    expect(card.skills[0]?.id).toBe('market_report');
    expect(card.skills[0]?.name).toBe('Premium Market Report');
  });

  it('combines the public base URL with the mount, with the pinned binding and version', async () => {
    const card = await cardFrom([resource()], { mountPath: '/agents/a2a' });
    expect(card.supportedInterfaces).toEqual([
      {
        url: 'https://gateway.example.com/agents/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ]);
  });

  it('never emits the obsolete top-level endpoint url', async () => {
    const card = await cardFrom([resource()]);
    expect(card).not.toHaveProperty('url');
    expect(card).not.toHaveProperty('preferredTransport');
  });

  it('adds no non-standard inputSchema to a skill', async () => {
    const card = await cardFrom([paid]);
    expect(card.skills[0]).not.toHaveProperty('inputSchema');
    expect(Object.keys(card.skills[0] ?? {}).sort()).toEqual([
      'description',
      'id',
      'inputModes',
      'name',
      'outputModes',
      'tags',
    ]);
  });

  it('declares JSON content modes and no streaming, push or extended card', async () => {
    const card = await cardFrom([resource()]);
    expect(card.defaultInputModes).toEqual(['application/json']);
    expect(card.defaultOutputModes).toEqual(['application/json']);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    });
  });

  it('marks a paid skill as paid and names its price', async () => {
    const card = await cardFrom([resource(), paid]);
    expect(card.skills[0]?.tags).toContain('free');
    expect(card.skills[1]?.tags).toContain('paid');
    expect(card.skills[1]?.description).toContain('0.01 USDC');
  });

  it.each([
    ['https://gateway.example.com/', '/a2a', 'https://gateway.example.com/a2a'],
    ['https://gateway.example.com', '/a2a/', 'https://gateway.example.com/a2a'],
    ['https://gateway.example.com//', '/a2a', 'https://gateway.example.com/a2a'],
  ])('joins %s + %s without a doubled slash', (base, mount, expected) => {
    expect(endpointUrl(base, mount)).toBe(expected);
  });

  it('builds an empty skill list rather than failing when nothing is exposed', () => {
    const card = buildAgentCard({
      name: 'agent-commerce',
      description: 'test',
      version: '0.0.0-test',
      publicBaseUrl: 'https://gateway.example.com',
      mountPath: '/a2a',
      resources: [],
    });
    expect(card.skills).toEqual([]);
  });
});

describe('A2A adapter lifecycle', () => {
  it('reports the pinned spec revision, experimental status and a complete unsupported list', () => {
    const { descriptor } = createA2aAdapter();
    expect(descriptor.name).toBe('a2a');
    expect(descriptor.supportedSpec).toBe('1.0.0');
    expect(descriptor.status).toBe('experimental');
    expect(descriptor.capabilities).toEqual(['agent-card', 'jsonrpc', 'SendMessage']);
    expect(descriptor.unsupported).toContain('SendStreamingMessage');
    expect(descriptor.unsupported).toContain('GetTask');
    expect(descriptor.unsupported).toContain('gRPC binding');
  });

  it('fails health before start and passes after, counting skills', async () => {
    const adapter = createA2aAdapter();
    expect((await adapter.health()).status).toBe('fail');

    await adapter.start(context([resource(), paid]));
    const healthy = await adapter.health();
    expect(healthy.status).toBe('pass');
    expect(healthy.detail).toContain('2 skill(s)');

    await adapter.stop();
    expect((await adapter.health()).status).toBe('fail');
  });

  it('serves 503 for the card once stopped, never a stale one', async () => {
    const adapter = createA2aAdapter();
    await adapter.start(context([resource()]));
    await adapter.stop();
    const res = await callCardRoute(adapter);
    expect(res.status).toBe(503);
    expect(res.body).not.toContain('weather_basic');
  });

  it('refuses a non-GET on the card route', async () => {
    const adapter = createA2aAdapter();
    await adapter.start(context([resource()]));
    expect((await callCardRoute(adapter, 'POST')).status).toBe(405);
  });
});
