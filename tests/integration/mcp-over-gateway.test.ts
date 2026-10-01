/**
 * An MCP client talking Streamable HTTP to a real `createGateway()` Fastify
 * server with a real `createMcpAdapter()` mounted. tests/conformance/mcp
 * drives the adapter over a bare node:http server and never reaches Fastify's
 * body parsing, which must leave the request body for the adapter to read.
 *
 * Fakes: ReceiptStore, BackendExecutor and, for the paid tool, PaymentProvider.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, IdGenerator } from '../../src/core';
import { DELIVERY_SUMMARY_META_KEY, PAYMENT_INPUT_FIELD } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createMcpAdapter } from '../../src/protocols/mcp';
import {
  createFakePaymentProvider,
  createFakeStore,
  makeGatewayConfig,
} from '../unit/gateway/helpers';

process.env['NODE_ENV'] = 'test';

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
        protocols: {
          http: { enabled: true },
          mcp: { enabled: true, mountPath: '/mcp' },
          a2a: { enabled: false, mountPath: '/a2a' },
          acp: { enabled: false, mountPath: '/acp' },
        },
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
        protocols: {
          http: { enabled: true },
          mcp: { enabled: true, mountPath: '/mcp' },
          a2a: { enabled: false, mountPath: '/a2a' },
          acp: { enabled: false, mountPath: '/acp' },
        },
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

    const listTools = (headers: Record<string, string>) =>
      fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
      });

    expect((await listTools({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await listTools({})).status).toBe(200);
  });
});

describe('paid MCP tool over the real gateway', () => {
  it('challenges, refuses a bad proof and delivers once only after settlement', async () => {
    let backendCalls = 0;
    let settleCalls = 0;
    gateway = await createGateway({
      config: makeGatewayConfig({
        resources: [
          {
            id: 'market_report',
            name: 'Premium Market Report',
            inputSchema: {
              type: 'object',
              properties: { symbol: { type: 'string' } },
              required: ['symbol'],
              additionalProperties: false,
            },
            handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
            pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
            exposedVia: ['mcp'],
            paymentMethods: ['x402'],
          },
        ],
      }),
      store: createFakeStore(),
      paymentProviders: [
        createFakePaymentProvider({
          verify: async (ctx) =>
            ctx.submission.payload === 'valid-proof'
              ? {
                  status: 'verified',
                  provider: 'x402',
                  amount: '0.01',
                  currency: 'USDC',
                  replayKey: 'replay-1',
                }
              : {
                  status: 'rejected',
                  provider: 'x402',
                  amount: '0.01',
                  currency: 'USDC',
                  rejectionReason: 'invalid_signature',
                },
          settle: async () => {
            settleCalls += 1;
            return {
              status: 'settled',
              provider: 'x402',
              amount: '0.01',
              currency: 'USDC',
              externalReference: '0xTXHASH',
            };
          },
        }),
      ],
      protocolAdapters: [createMcpAdapter()],
      clock,
      ids,
      backend: {
        call: async () => {
          backendCalls += 1;
          return { status: 200, headers: {}, body: { symbol: 'ETH', price: 42 }, durationMs: 1 };
        },
      },
    });
    const { url } = await gateway.listen();
    client = new Client({ name: 'integration-test-client', version: '0.0.0-test' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)) as Transport);
    const buy = async (args: Record<string, unknown>) =>
      (await client?.callTool({
        name: 'market_report',
        arguments: { symbol: 'ETH', ...args },
      })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      };

    const challenged = await buy({});
    expect(challenged.isError).toBe(true);
    expect(challenged.structuredContent).toMatchObject({
      code: 'PAYMENT_REQUIRED',
      payment: { provider: 'x402', amount: '0.01', currency: 'USDC', destination: '0xMERCHANT' },
    });

    const refused = await buy({ [PAYMENT_INPUT_FIELD]: 'forged-proof' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: 'PAYMENT_INVALID' });
    expect(settleCalls).toBe(0);
    expect(backendCalls).toBe(0);

    const paid = await buy({ [PAYMENT_INPUT_FIELD]: 'valid-proof' });
    expect(paid.isError).not.toBe(true);
    expect(paid.structuredContent).toEqual({ symbol: 'ETH', price: 42 });
    expect(paid._meta?.[DELIVERY_SUMMARY_META_KEY]).toMatchObject({
      resourceId: 'market_report',
      payment: { status: 'settled', amount: '0.01', externalReference: '0xTXHASH' },
    });
    expect(settleCalls).toBe(1);
    expect(backendCalls).toBe(1);
  });
});
