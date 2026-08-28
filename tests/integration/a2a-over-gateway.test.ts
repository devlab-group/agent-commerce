/**
 * The Agent Card fetched the way a client fetches it: over a real
 * `createGateway()` Fastify instance with a real `createA2aAdapter()` mounted.
 * A card built correctly but never reachable at its fixed path is not
 * discovery, and only a test that traverses the gateway can tell the two
 * apart.
 *
 * Fakes: ReceiptStore only. The adapter and the gateway are the real ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../src/config/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createA2aAdapter } from '../../src/protocols/a2a/index.js';
import type { A2aAgentCard } from '../../src/protocols/a2a/types.js';
import { createMcpAdapter } from '../../src/protocols/mcp/index.js';
import { createFakeStore } from '../unit/gateway/helpers.js';

process.env['NODE_ENV'] = 'test';

let gateway: GatewayInstance | undefined;

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
    },
    resources: [
      {
        id: 'weather_basic',
        name: 'Basic Weather',
        description: 'Current weather for a city.',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
        pricing: { type: 'free' },
        exposedVia: ['http', 'mcp', 'a2a'],
        paymentMethods: [],
      },
      {
        id: 'mcp_only',
        name: 'MCP Only',
        inputSchema: { type: 'object', properties: {} },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/mcp-only' },
        pricing: { type: 'free' },
        exposedVia: ['mcp'],
        paymentMethods: [],
      },
    ],
    payments: {},
  };
}

async function startGateway(): Promise<GatewayInstance> {
  gateway = await createGateway({
    config: config(),
    store: createFakeStore(),
    paymentProviders: [],
    protocolAdapters: [createMcpAdapter(), createA2aAdapter()],
  });
  return gateway;
}

describe('A2A agent card over the real gateway', () => {
  it('serves the card at the spec-fixed path with the gateway public base URL', async () => {
    const gw = await startGateway();

    const res = await gw.server.inject({ method: 'GET', url: '/.well-known/agent-card.json' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const card = res.json<A2aAgentCard>();
    expect(card.protocolVersion).toBe('1.0');
    expect(card.supportedInterfaces).toEqual([
      {
        url: 'http://localhost:8080/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ]);
    expect(card.skills.map((s) => s.id)).toEqual(['weather_basic']);
    expect(card).not.toHaveProperty('url');
  });

  it('leaves the gateway own well-known document and the MCP mount untouched', async () => {
    const gw = await startGateway();

    const wellKnown = await gw.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(wellKnown.statusCode).toBe(200);

    // POST is MCP's only method; a 200 here would mean the A2A card route had
    // swallowed the neighbouring mount.
    const mcp = await gw.server.inject({ method: 'GET', url: '/mcp' });
    expect(mcp.statusCode).toBe(405);
  });
});
