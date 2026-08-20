/**
 * Regression test for the CRITICAL content-type-parser bug: an MCP client
 * talks Streamable HTTP to a REAL `createGateway()` Fastify server with a
 * REAL `createMcpAdapter()` mounted — unlike tests/conformance/mcp, which
 * drives the adapter over a bare node:http server and never exercises
 * Fastify's body parsing at all. That gap is exactly why the bug shipped
 * with 400+ green tests elsewhere.
 *
 * Fakes: ReceiptStore and BackendExecutor only (per, core's tests
 * don't depend on other areas' internals) — the MCP adapter itself is the
 * real src/protocols/mcp package, and requests traverse the
 * real Fastify instance.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterDescriptor,
  Clock,
  CommerceEvent,
  CommerceReceipt,
  IdGenerator,
  PaymentAttempt,
  ReceiptStore,
} from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createMcpAdapter } from '../../src/protocols/mcp/index.js';

process.env['NODE_ENV'] = 'test';

const descriptor: AdapterDescriptor = {
  name: 'fake-store',
  kind: 'storage',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'n/a',
  capabilities: [],
  status: 'experimental',
};

function createFakeStore(): ReceiptStore {
  const events: CommerceEvent[] = [];
  const receipts: CommerceReceipt[] = [];
  const attempts = new Map<string, PaymentAttempt>();
  return {
    async init() {},
    async appendEvent(event) {
      events.push(event);
    },
    async reservePaymentAttempt(reservation) {
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
    async updatePaymentAttempt() {},
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
    descriptor,
    async health() {
      return { status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' };
    },
    async close() {},
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

let gateway: GatewayInstance | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  client = undefined;
  gateway = undefined;
});

describe('MCP over the real gateway (Fastify body-parsing regression)', () => {
  it('lists tools and calls one end to end through Fastify + a real MCP client', async () => {
    gateway = await createGateway({
      config: {
        version: 1,
        merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
        server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
        storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
        protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
        resources: [
          {
            id: 'weather_basic',
            name: 'Basic Weather',
            inputSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
              additionalProperties: false,
            },
            handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
            pricing: { type: 'free' },
            exposedVia: ['http', 'mcp'],
            paymentMethods: [],
          },
        ],
        payments: {},
      },
      store: createFakeStore(),
      paymentProviders: [],
      protocolAdapters: [createMcpAdapter()],
      clock,
      ids,
      backend: {
        call: async () => ({
          status: 200,
          headers: {},
          body: { city: 'Berlin', tempC: 21 },
          durationMs: 1,
        }),
      },
    });

    const { url } = await gateway.listen();

    client = new Client({ name: 'integration-test-client', version: '0.0.0-test' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
    await client.connect(transport as Transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('weather_basic');

    const result = await client.callTool({ name: 'weather_basic', arguments: { city: 'Berlin' } });
    const content = (
      result as { isError?: boolean; content: Array<{ type: string; text?: string }> }
    ).content;
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    const text = content.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('Berlin');
  });

  it('rejects tools/list at /mcp with a disallowed Origin', async () => {
    gateway = await createGateway({
      config: {
        version: 1,
        merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
        server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
        storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
        protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
        resources: [],
        payments: {},
      },
      store: createFakeStore(),
      paymentProviders: [],
      protocolAdapters: [createMcpAdapter()],
      clock,
      ids,
    });

    const { url } = await gateway.listen();

    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    });

    expect(res.status).toBe(403);
  });
});
