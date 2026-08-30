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

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpc(
  gw: GatewayInstance,
  payload: unknown,
  headers: Record<string, string> = { 'a2a-version': '1.0' },
): Promise<{ statusCode: number; body: JsonRpcResponse }> {
  const res = await gw.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { statusCode: res.statusCode, body: res.json<JsonRpcResponse>() };
}

function sendMessage(data: unknown, id: string | number = 'req-1'): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'SendMessage',
    params: {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-1',
        parts: [{ data, mediaType: 'application/json' }],
      },
    },
  };
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

describe('A2A JSON-RPC transport over the real gateway', () => {
  it('reaches the adapter with the request body intact and answers as JSON-RPC', async () => {
    const gw = await startGateway();
    const { statusCode, body } = await rpc(gw, sendMessage({ resource: 'weather_basic' }));

    expect(statusCode).toBe(200);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('req-1');
    // Phase 5 stops at the transport boundary: a well-formed call parses,
    // then reports that execution is not wired rather than inventing a result.
    expect(body.error?.code).toBe(-32603);
  });

  it('rejects the legacy message/send method name as unknown', async () => {
    const gw = await startGateway();
    const { body } = await rpc(gw, {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { role: 'ROLE_USER', parts: [{ data: { resource: 'weather_basic' } }] } },
    });
    expect(body.error?.code).toBe(-32601);
  });

  it.each([
    ['a known but unsupported operation', 'SendStreamingMessage', -32004],
    ['another unsupported operation', 'GetTask', -32004],
    ['a completely unknown method', 'DoSomething', -32601],
  ])('distinguishes %s', async (_label, method, code) => {
    const gw = await startGateway();
    const { body } = await rpc(gw, { jsonrpc: '2.0', id: 1, method, params: {} });
    expect(body.error?.code).toBe(code);
  });

  it.each([
    ['malformed JSON', '{"jsonrpc":', -32700],
    ['a non-object request', '"hello"', -32600],
    ['a batch request', '[{"jsonrpc":"2.0","id":1,"method":"SendMessage"}]', -32600],
  ])('rejects %s', async (_label, payload, code) => {
    const gw = await startGateway();
    const { statusCode, body } = await rpc(gw, payload);
    expect(statusCode).toBe(200);
    expect(body.error?.code).toBe(code);
  });

  it.each([
    ['a wrong jsonrpc version', { jsonrpc: '1.0', id: 1, method: 'SendMessage' }, -32600],
    ['a missing method', { jsonrpc: '2.0', id: 1 }, -32600],
    ['non-object params', { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: [] }, -32602],
  ])('rejects %s', async (_label, payload, code) => {
    const gw = await startGateway();
    const { body } = await rpc(gw, payload);
    expect(body.error?.code).toBe(code);
    expect(body.id).toBe(1);
  });

  it('maps an invalid invocation envelope to invalid params', async () => {
    const gw = await startGateway();
    const { body } = await rpc(gw, sendMessage({ input: { city: 'Berlin' } }));
    expect(body.error?.code).toBe(-32602);
  });

  it('maps a legal but unsupported A2A structure to unsupported operation', async () => {
    const gw = await startGateway();
    const { body } = await rpc(gw, {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: {
        message: { role: 'ROLE_USER', parts: [{ text: 'give me the weather' }] },
      },
    });
    expect(body.error?.code).toBe(-32004);
  });

  it.each([
    ['a missing version header', {}],
    ['an older version', { 'a2a-version': '0.3' }],
    ['an unknown version', { 'a2a-version': '2.0' }],
  ])('refuses %s', async (_label, headers) => {
    const gw = await startGateway();
    const { statusCode, body } = await rpc(gw, sendMessage({ resource: 'weather_basic' }), {
      'content-type': 'application/json',
      ...headers,
    });
    expect(statusCode).toBe(200);
    expect(body.error?.code).toBe(-32004);
    expect(body.error?.message).toContain('1.0');
  });

  it('answers 405 to a GET on the JSON-RPC mount', async () => {
    const gw = await startGateway();
    const res = await gw.server.inject({ method: 'GET', url: '/a2a' });
    expect(res.statusCode).toBe(405);
    expect(res.json<JsonRpcResponse>().error?.code).toBe(-32600);
  });

  it('leaks no internals in any error message', async () => {
    const gw = await startGateway();
    const responses = await Promise.all([
      rpc(gw, '{"jsonrpc":'),
      rpc(gw, sendMessage({ resource: 7 })),
      rpc(gw, { jsonrpc: '2.0', id: 1, method: 'GetTask' }),
      rpc(gw, sendMessage({ resource: 'weather_basic' }), { 'content-type': 'application/json' }),
    ]);
    for (const { body } of responses) {
      const message = body.error?.message ?? '';
      expect(message).not.toMatch(/\bat .*:\d+:\d+/); // stack frame
      expect(message).not.toMatch(/[/\\](src|node_modules)[/\\]/); // path
      expect(message).not.toMatch(/Error:|SQLITE|ZodError|TypeError/);
    }
  });
});
