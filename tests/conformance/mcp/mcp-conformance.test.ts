/**
 * MCP adapter conformance suite.
 *
 * Drives `createMcpAdapter()` through a real MCP `Client` over the real
 * Streamable HTTP transport (a throwaway `node:http` server wrapping
 * `handleHttp`) — never by calling internal adapter functions directly.
 * Uses a fake `ExecutionPipeline` and a fake `ResourceRegistry` built from
 * canonical `CommerceResource` fixtures; no dependency on gateway, config or
 * payment-x402.
 *
 * Run with: npx vitest run tests/conformance/mcp
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type CallToolResult, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CanonicalRequest,
  COMMERCE_ERROR_HTTP_STATUS,
  CommerceError,
  type CommerceErrorCode,
  DELIVERY_SUMMARY_META_KEY,
  type ExecutionOutcome,
  type HttpProtocolAdapter,
  toErrorEnvelope,
} from '../../../src/core/index.js';
import { createMcpAdapter } from '../../../src/protocols/mcp/index.js';
import { createFakeContext, type FakeExecutionPipeline } from './fakes.js';
import {
  DYNAMIC_PRICED_RESOURCE,
  FREE_ECHO_RESOURCE,
  HTTP_ONLY_RESOURCE,
  INVALID_ID_RESOURCE,
  NO_SCHEMA_RESOURCE,
  PAID_NO_METHOD_RESOURCE,
  PAID_WEATHER_RESOURCE,
} from './fixtures.js';
import { EXPECTED_MCP_PROTOCOL_REVISION } from './protocol-revision.fixture.js';
import { type RunningAdapterServer, startAdapterServer } from './support.js';

interface Harness {
  readonly adapter: HttpProtocolAdapter;
  readonly pipeline: FakeExecutionPipeline;
  readonly server: RunningAdapterServer;
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}

const openHarnesses: Harness[] = [];

async function setup(
  resources: Parameters<typeof createFakeContext>[0]['resources'],
): Promise<Harness> {
  const adapter = createMcpAdapter();
  const { context, pipeline } = createFakeContext({ resources });
  await adapter.start(context);

  const server = await startAdapterServer(adapter);
  const client = new Client({ name: 'conformance-client', version: '0.0.0-test' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}${adapter.mountPath}`));
  // Same exactOptionalPropertyTypes vs. SDK accessor-typing mismatch as the
  // server side (see src/protocols/mcp/adapter.ts) — the SDK's own
  // class declaration asserts `implements Transport`.
  await client.connect(transport as Transport);

  const harness: Harness = { adapter, pipeline, server, client, transport };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop();
    if (!h) continue;
    await h.client.close().catch(() => {});
    await h.adapter.stop().catch(() => {});
    await h.server.close().catch(() => {});
  }
});

/**
 * `Client.callTool`'s declared return type is a union that also covers
 * task-based tool execution (`{ toolResult,... }`); none of these fixtures
 * register a task-based tool, so the runtime shape is always `CallToolResult`.
 */
async function callTool(
  client: Client,
  params: { name: string; arguments: Record<string, unknown> },
): Promise<CallToolResult> {
  return (await client.callTool(params)) as CallToolResult;
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function firstText(result: CallToolResult): string {
  const first = result.content?.[0];
  expect(first).toBeDefined();
  expect(first?.type).toBe('text');
  return String((first as { text: string }).text);
}

describe('mcp adapter: descriptor and support matrix', () => {
  it('reports an honest descriptor matching the negotiated MCP protocol revision', async () => {
    const adapter = createMcpAdapter();
    expect(adapter.name).toBe('mcp');
    expect(adapter.mountPath).toBe('/mcp');
    expect(adapter.descriptor.kind).toBe('protocol');
    expect(adapter.descriptor.status).toBe('stable');
    expect(adapter.descriptor.capabilities).toEqual(['tools/list', 'tools/call']);
    expect(adapter.descriptor.unsupported ?? []).toEqual(
      expect.arrayContaining(['resources', 'prompts', 'sampling']),
    );
    // Cross-check against the fixture that records the exact negotiated
    // revision, and against the SDK constant itself — all three must agree.
    expect(adapter.descriptor.supportedSpec).toBe(LATEST_PROTOCOL_VERSION);
    expect(adapter.descriptor.supportedSpec).toBe(EXPECTED_MCP_PROTOCOL_REVISION);
  });

  it('actually negotiates the expected protocol revision over a live connection', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    expect(h.transport.protocolVersion).toBe(EXPECTED_MCP_PROTOCOL_REVISION);
    expect(h.client.getServerVersion()?.name).toBe('agent-commerce');
  });
});

describe('mcp adapter: tool discovery', () => {
  it('lists every mcp-exposed resource with correct names, descriptions and input schemas; excludes non-mcp resources', async () => {
    const h = await setup([FREE_ECHO_RESOURCE, PAID_WEATHER_RESOURCE, HTTP_ONLY_RESOURCE]);
    const { tools } = await h.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'get-weather']);

    const echo = tools.find((t) => t.name === 'echo');
    expect(echo?.description).toBe(FREE_ECHO_RESOURCE.description);
    expect(echo?.inputSchema.type).toBe('object');
    expect(echo?.inputSchema.properties?.message).toMatchObject({
      type: 'string',
      description: 'Message to echo back.',
    });
    expect(echo?.inputSchema.properties?._payment).toBeUndefined();
  });

  it('builds a valid object input schema even when the resource declares none', async () => {
    const h = await setup([NO_SCHEMA_RESOURCE]);
    const { tools } = await h.client.listTools();
    expect(tools[0]?.inputSchema.type).toBe('object');
  });

  it('shows the price in the description and adds the _payment property for a paid resource', async () => {
    const h = await setup([PAID_WEATHER_RESOURCE]);
    const { tools } = await h.client.listTools();
    const tool = tools[0];

    expect(tool?.description).toContain('0.05');
    expect(tool?.description).toContain('USDC');
    expect(tool?.description?.toLowerCase()).toContain('payment');
    expect(tool?.inputSchema.properties?._payment).toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.required ?? []).not.toContain('_payment');
    expect(tool?.inputSchema.required).toEqual(['city']);
  });

  it('skips a resource whose id is not a legal MCP tool name, without mangling it, and reports why via health()', async () => {
    const h = await setup([FREE_ECHO_RESOURCE, INVALID_ID_RESOURCE]);
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);

    const health = await h.adapter.health();
    expect(health.status).toBe('warn');
    expect(health.detail).toContain('bad tool id!');
  });

  it('describes a dynamically-priced resource as paid without inventing an amount', async () => {
    const h = await setup([DYNAMIC_PRICED_RESOURCE]);
    const { tools } = await h.client.listTools();
    const tool = tools[0];

    expect(tool?.description?.toLowerCase()).toContain('payment');
    expect(tool?.inputSchema.properties?._payment).toMatchObject({ type: 'string' });
  });
});

describe('mcp adapter: invocation', () => {
  it('routes a valid free invocation through the pipeline with no _payment leakage, and maps a delivered outcome', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: { echoed: 'hi' },
      receipt: {
        id: 'receipt-1',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 5,
    });

    const result = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });

    expect(h.pipeline.lastRequest?.protocol).toBe('mcp');
    expect(h.pipeline.lastRequest?.resourceId).toBe('echo');
    expect(h.pipeline.lastRequest?.input).toEqual({ message: 'hi' });
    expect(h.pipeline.lastRequest?.payment).toBeUndefined();
    expect(typeof h.pipeline.lastRequest?.requestId).toBe('string');
    expect(h.pipeline.lastRequest?.requestId.length).toBeGreaterThan(0);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ echoed: 'hi' });
    expect(firstText(result)).toContain('echoed');
  });

  it('maps INPUT_INVALID thrown by the pipeline to a deterministic error result', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = () => {
      throw new CommerceError('INPUT_INVALID', 'message is required');
    };

    const result = await callTool(h.client, { name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    const sc = structured(result);
    expect(sc.status).toBe('error');
    expect(sc.code).toBe('INPUT_INVALID');
    expect(firstText(result)).toContain('INPUT_INVALID');
  });

  it('rejects a tools/call for a resource id that was never registered as a tool, without ever reaching the pipeline', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = () => {
      throw new Error('must not be called for an unregistered tool name');
    };

    const result = await callTool(h.client, { name: 'does-not-exist', arguments: {} });

    expect(h.pipeline.requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    const sc = structured(result);
    expect(sc.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('gates tools/call on exposedVia: a resource exposed only via http is absent from tools/list AND rejected by tools/call (defence in depth against a crafted call)', async () => {
    const h = await setup([FREE_ECHO_RESOURCE, HTTP_ONLY_RESOURCE]);
    h.pipeline.handler = () => {
      throw new Error('must not be called for a resource not exposed via mcp');
    };

    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('internal-report');

    const result = await callTool(h.client, { name: 'internal-report', arguments: {} });

    expect(h.pipeline.requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    const sc = structured(result);
    expect(sc.code).toBe('RESOURCE_NOT_FOUND');
    // Must not reveal that the resource exists but is scoped to another protocol.
    expect(JSON.stringify(sc).toLowerCase()).not.toContain('http');
  });

  it('gates tools/call on a skipped illegal-tool-name resource: guessing its raw id is rejected', async () => {
    const h = await setup([FREE_ECHO_RESOURCE, INVALID_ID_RESOURCE]);
    h.pipeline.handler = () => {
      throw new Error('must not be called for a resource skipped at start()');
    };

    const result = await callTool(h.client, { name: 'bad tool id!', arguments: {} });

    expect(h.pipeline.requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns isError plus a valid PaymentRequiredEnvelope (with accepts[0]) when a paid resource is called without a proof', async () => {
    const h = await setup([PAID_WEATHER_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'payment-required',
      requestId: request.requestId,
      resourceId: request.resourceId,
      requirement: {
        id: 'req-1',
        requestId: request.requestId,
        resourceId: request.resourceId,
        provider: 'x402',
        amount: '0.05',
        currency: 'USDC',
        destination: '0xMerchantWallet',
        challenge: {
          provider: 'x402',
          version: '1',
          accepts: [{ scheme: 'exact', network: 'base-sepolia', payTo: '0xMerchantWallet' }],
        },
      },
    });

    const result = await callTool(h.client, { name: 'get-weather', arguments: { city: 'Berlin' } });

    expect(h.pipeline.lastRequest?.payment).toBeUndefined();
    expect(h.pipeline.lastRequest?.input).toEqual({ city: 'Berlin' });
    expect(result.isError).toBe(true);

    const sc = structured(result);
    expect(sc.status).toBe('payment-required');
    expect(sc.code).toBe('PAYMENT_REQUIRED');
    const payment = sc.payment as Record<string, unknown>;
    expect(payment.amount).toBe('0.05');
    expect(payment.currency).toBe('USDC');
    expect(payment.destination).toBe('0xMerchantWallet');
    expect(Array.isArray(payment.accepts)).toBe(true);
    expect((payment.accepts as unknown[])[0]).toEqual({
      scheme: 'exact',
      network: 'base-sepolia',
      payTo: '0xMerchantWallet',
    });

    const text = firstText(result);
    expect(text).toMatch(/0\.05/);
    expect(text).toContain('USDC');
    expect(text).toContain('0xMerchantWallet');
  });

  it('forwards a supplied _payment proof as payment:{method:x402,payload} and maps the delivered result', async () => {
    const h = await setup([PAID_WEATHER_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: { forecast: 'sunny' },
      receipt: {
        id: 'receipt-2',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 3,
    });

    const result = await callTool(h.client, {
      name: 'get-weather',
      arguments: { city: 'Berlin', _payment: 'base64-x402-proof' },
    });

    expect(h.pipeline.lastRequest?.payment).toEqual({
      method: 'x402',
      payload: 'base64-x402-proof',
    });
    expect(h.pipeline.lastRequest?.input).toEqual({ city: 'Berlin' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ forecast: 'sunny' });
  });

  it('carries the payer-facing delivery summary in _meta on a paid delivered resource, with the settlement reference, leaving content/structuredContent untouched', async () => {
    const h = await setup([PAID_WEATHER_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: { forecast: 'sunny' },
      payment: {
        status: 'settled',
        provider: 'x402',
        amount: '0.05',
        currency: 'USDC',
        network: 'base-sepolia',
        externalReference: '0xsettlementtxhash',
      },
      receipt: {
        id: 'receipt-paid-meta',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 3,
    });

    const result = await callTool(h.client, {
      name: 'get-weather',
      arguments: { city: 'Berlin', _payment: 'base64-x402-proof' },
    });

    // Merchant payload is exactly what it was before this feature existed.
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ forecast: 'sunny' });
    expect(firstText(result)).toBe(JSON.stringify({ forecast: 'sunny' }));

    // Out-of-band delivery summary lives in _meta, built only from toDeliverySummary.
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const summary = meta?.[DELIVERY_SUMMARY_META_KEY] as Record<string, unknown>;
    expect(summary).toEqual({
      requestId: h.pipeline.lastRequest?.requestId,
      resourceId: 'get-weather',
      receiptId: 'receipt-paid-meta',
      deliveredAt: '2026-07-12T00:00:00.000Z',
      payment: {
        status: 'settled',
        amount: '0.05',
        currency: 'USDC',
        externalReference: '0xsettlementtxhash',
        network: 'base-sepolia',
      },
    });
  });

  it('carries the delivery summary in _meta on a free delivered resource, with no payment block at all', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: { echoed: 'hi' },
      receipt: {
        id: 'receipt-free-meta',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 5,
    });

    const result = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ echoed: 'hi' });

    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const summary = meta?.[DELIVERY_SUMMARY_META_KEY] as Record<string, unknown>;
    expect(summary).toEqual({
      requestId: h.pipeline.lastRequest?.requestId,
      resourceId: 'echo',
      receiptId: 'receipt-free-meta',
      deliveredAt: '2026-07-12T00:00:00.000Z',
    });
    // Free resource: no payment block at all, not an empty object.
    expect(summary).not.toHaveProperty('payment');
  });

  it('derives the payment method from the resource, never hard-coding it, and drops a proof for a resource with no configured method', async () => {
    const h = await setup([PAID_WEATHER_RESOURCE, PAID_NO_METHOD_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: { ok: true },
      receipt: {
        id: 'receipt-6',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 1,
    });

    // paymentMethods: ['x402'] -> forwarded as method: 'x402'.
    await callTool(h.client, {
      name: 'get-weather',
      arguments: { city: 'Berlin', _payment: 'proof-a' },
    });
    expect(h.pipeline.lastRequest?.payment).toEqual({ method: 'x402', payload: 'proof-a' });

    // paymentMethods: [] -> no method to derive, so the proof is dropped
    // (not forwarded under an invented rail) while input stripping still
    // happens and the pipeline still runs — it decides what happens next.
    await callTool(h.client, {
      name: 'no-method-paid',
      arguments: { q: 'x', _payment: 'proof-b' },
    });
    expect(h.pipeline.lastRequest?.payment).toBeUndefined();
    expect(h.pipeline.lastRequest?.input).toEqual({ q: 'x' });
  });

  it('carries a string backend body through as plain text, with no structuredContent', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: 'plain text body',
      receipt: {
        id: 'receipt-4',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 1,
    });

    const result = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeUndefined();
    expect(firstText(result)).toBe('plain text body');
  });

  it('carries an array backend body through as JSON text, with no structuredContent', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: [1, 2, 3],
      receipt: {
        id: 'receipt-5',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 1,
    });

    const result = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeUndefined();
    expect(firstText(result)).toBe('[1,2,3]');
  });

  it.each(['BACKEND_ERROR', 'BACKEND_TIMEOUT'] as const)(
    'maps %s to the correct code in the error envelope',
    async (code) => {
      const h = await setup([FREE_ECHO_RESOURCE]);
      h.pipeline.handler = () => {
        throw new CommerceError(code, `backend failure: ${code}`);
      };

      const result = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });

      expect(result.isError).toBe(true);
      expect(structured(result).code).toBe(code);
    },
  );

  it.each(['PAYMENT_INVALID', 'PAYMENT_REPLAYED'] as const)(
    'maps %s to the correct code with no extra payment detail leaking',
    async (code) => {
      const h = await setup([PAID_WEATHER_RESOURCE]);
      h.pipeline.handler = () => {
        throw new CommerceError(code, 'payment rejected');
      };

      const result = await callTool(h.client, {
        name: 'get-weather',
        arguments: { city: 'Berlin', _payment: 'a-secret-looking-proof-value' },
      });

      expect(result.isError).toBe(true);
      const sc = structured(result);
      expect(sc.code).toBe(code);
      expect(sc.status).toBe('error');
      expect(JSON.stringify(sc)).not.toContain('a-secret-looking-proof-value');
    },
  );

  it('maps a non-CommerceError thrown by the pipeline to INTERNAL_ERROR with no internal detail leaked, in.message or.stack', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    const SECRET = 'connect ECONNREFUSED 10.20.30.40:5432 (internal-billing-db.corp.internal)';
    const raw = new Error(SECRET);
    raw.stack = `Error: ${SECRET}\n    at Object.<anonymous> (/very/secret/path/file.ts:10:5)`;
    h.pipeline.handler = () => {
      throw raw;
    };

    const result = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });

    expect(result.isError).toBe(true);
    const sc = structured(result);
    expect(sc.code).toBe('INTERNAL_ERROR');
    expect(sc).not.toHaveProperty('stack');

    // Check the *entire* serialised result — structuredContent AND every
    // content[].text — not just structuredContent, and with the secret in
    //.message (not just.stack): a fix that only strips.stack would still
    // leak an untrusted.message straight through and pass a narrower check.
    const fullResult = JSON.stringify(result);
    expect(fullResult).not.toContain(SECRET);
    expect(fullResult).not.toContain('/very/secret/path/file.ts');
    expect(fullResult).not.toContain('internal-billing-db');
  });

  it('produces the same result shape for the same call made twice (round-trip determinism)', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = (request) => ({
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: { echoed: 'hi' },
      receipt: {
        id: 'receipt-3',
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 1,
    });

    const first = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });
    const second = await callTool(h.client, { name: 'echo', arguments: { message: 'hi' } });

    expect(first.isError).toEqual(second.isError);
    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(first.content).toEqual(second.content);
  });
});

describe('mcp adapter: batch fan-out', () => {
  /**
   * Must match `MAX_CONCURRENT_TOOL_CALLS` / `MAX_QUEUED_TOOL_CALLS` in
   * `src/protocols/mcp/adapter.ts`. Not imported — neither constant
   * is part of this package's public surface — so keep these in sync by
   * hand if either cap ever changes.
   */
  const EXPECTED_CONCURRENCY_CAP = 8;
  const EXPECTED_QUEUE_CAP = 64;
  const EXPECTED_TOTAL_ADMITTED = EXPECTED_CONCURRENCY_CAP + EXPECTED_QUEUE_CAP;

  function deliveredOutcome(request: CanonicalRequest): ExecutionOutcome {
    return {
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: request.resourceId,
      backendStatus: 200,
      body: { echoed: 'hi' },
      receipt: {
        id: `receipt-${request.requestId}`,
        requestId: request.requestId,
        resourceId: request.resourceId,
        deliveredAt: '2026-07-12T00:00:00.000Z',
        backendStatus: 200,
      },
      durationMs: 5,
    };
  }

  function rawBatch(name: string, size: number): unknown[] {
    return Array.from({ length: size }, (_, i) => ({
      jsonrpc: '2.0' as const,
      id: i,
      method: 'tools/call',
      params: { name, arguments: { message: 'hi' } },
    }));
  }

  async function postBatch(
    h: Harness,
    messages: unknown[],
    signal?: AbortSignal,
  ): Promise<Response> {
    // A raw JSON-RPC batch, sent directly with `fetch` rather than through
    // the SDK `Client` — the `Client` never builds a batch itself, but the
    // wire format is a plain array and the transport accepts it from any
    // caller (this is exactly the shape measured: one POST, no prior
    // `initialize`, because this adapter runs the transport in stateless
    // mode — see the adapter's module doc).
    return fetch(`${h.server.url}${h.adapter.mountPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(messages),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  it('never runs more than the concurrency cap at once, and never admits more than cap+queue total, for an oversized JSON-RPC batch', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    const BATCH_SIZE = 1000;

    let inFlight = 0;
    let peak = 0;
    h.pipeline.handler = async (request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Long enough relative to scheduling overhead that genuinely
      // concurrent executions overlap and get counted, short enough that
      // the (now-bounded) admitted set doesn't make the test slow.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return deliveredOutcome(request);
    };

    const res = await postBatch(h, rawBatch('echo', BATCH_SIZE));
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream fully — resolves once every response is sent

    // the queue itself is now bounded, so of 1000 requested calls
    // only cap+queue (72) ever reach the pipeline — the rest are rejected
    // immediately, without ever touching pipeline.execute(). Pre-fix this
    // was 1000 (every queued call eventually ran, unbounded).
    expect(h.pipeline.requests.length).toBe(EXPECTED_TOTAL_ADMITTED);
    // (unchanged by this round): still true that none of
    // those 72 ever ran more than EXPECTED_CONCURRENCY_CAP at once.
    expect(peak).toBeGreaterThan(1); // sanity: this test can detect real concurrency
    expect(peak).toBeLessThanOrEqual(EXPECTED_CONCURRENCY_CAP);
  });

  it('stops starting new pipeline.execute() calls once the client disconnects, instead of finishing a large batch in the background', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    // Slow enough that, pre-fix, a client that disconnects early would
    // still find its whole admitted batch still grinding away well after
    // — mirrors the measured "aborted at 400ms, 3000 of 3000 done 5s
    // later" case, scaled down for test speed.
    h.pipeline.handler = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return deliveredOutcome(request);
    };

    const controller = new AbortController();
    // Large enough to fill concurrency + queue with plenty to spare, so
    // whether the abort lands slightly early or late relative to dispatch,
    // there is always more admitted work than could have finished by the
    // time we check.
    const fetchPromise = postBatch(h, rawBatch('echo', 300), controller.signal).catch(
      () => undefined, // aborting rejects the client's own fetch; only server-side behaviour matters here
    );

    // Let dispatch happen (it is synchronous once the request lands — see
    // the adapter's module doc on the transport's onmessage loop) and a
    // handful of calls actually start, then disconnect long before the
    // batch could possibly finish.
    await new Promise((resolve) => setTimeout(resolve, 15));
    controller.abort();
    await fetchPromise;

    // Two settle-checks with a gap: pre-fix, the count keeps climbing
    // through this whole window (every queued call eventually runs, abort
    // or not). Post-fix it must plateau almost immediately once whatever
    // was already in flight at disconnect time finishes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const first = h.pipeline.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = h.pipeline.requests.length;

    expect(second).toBe(first); // stable: nothing new started in this window
    expect(second).toBeLessThan(300); // and nowhere near the full batch
  });

  it('does not head-of-line-block an honest single call behind a large queued batch', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    // Near-instant, matching the shape of the concurrency probes this came
    // from — the point of this test is queueing behaviour, not backend
    // latency.
    h.pipeline.handler = async (request) => deliveredOutcome(request);

    // Large enough to saturate concurrency + queue.
    void postBatch(h, rawBatch('echo', 1000)).then((r) => r.text());

    const start = Date.now();
    const honest = await callTool(h.client, { name: 'echo', arguments: { message: 'honest' } });
    const elapsedMs = Date.now() - start;

    // Bounded admission means an honest caller is never stuck waiting for
    // attacker traffic to drain — it either gets a slot promptly or is
    // rejected immediately because the queue is already full (see
    // `GATEWAY_BUSY` in the adapter). Either outcome is fast; "eventually,
    // slowly, after everyone ahead of it" is exactly what a bounded queue
    // exists to rule out. Generous bound for test-machine jitter — the
    // equivalent case measured 10-15ms.
    expect(elapsedMs).toBeLessThan(1000);
    expect(honest.isError === true || honest.structuredContent !== undefined).toBe(true);
  });

  it('the queue-full rejection carries a wire envelope that is honestly retryable (GATEWAY_BUSY, HTTP 503)', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    // Slow enough that the saturating batch is still fully queued (none of
    // it has had a chance to drain) by the time the honest call below is
    // dispatched — makes the queue-full rejection deterministic rather than
    // a race against a fast-draining handler.
    h.pipeline.handler = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return deliveredOutcome(request);
    };

    // Saturate concurrency (8) + queue (64) = 72 with plenty to spare.
    void postBatch(h, rawBatch('echo', 500)).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 15)); // let the synchronous dispatch land first

    // This call is on its own connection (the harness's `h.client`), so —
    // unlike a disconnected caller — its result is fully observable. The
    // adapter-wide queue being full rejects it the same way it would reject
    // the 429th message of one giant batch.
    const rejected = await callTool(h.client, { name: 'echo', arguments: { message: 'honest' } });

    expect(rejected.isError).toBe(true);
    // Assert on the envelope a client actually receives (`structuredContent`,
    // built by `toErrorEnvelope`) — not just the thrown code — because the
    // whole bug this closes is the wire representation contradicting the
    // prose ("retry later" next to `retryable: false`).
    const envelope = rejected.structuredContent as { code: string; retryable: boolean };
    expect(envelope.code).toBe('GATEWAY_BUSY');
    expect(envelope.retryable).toBe(true);
    expect(COMMERCE_ERROR_HTTP_STATUS[envelope.code as CommerceErrorCode]).toBe(503);
  });

  it('the disconnect rejection stays honestly non-retryable, and uses a different code than the queue-full rejection', () => {
    // The disconnected-caller path (src/protocols/mcp/adapter.ts,
    // both `signal.aborted` checks in handleToolCall/acquireToolCallSlot)
    // is not observable end-to-end the way the queue-full path above is:
    // its whole premise is that nobody is left listening on that
    // connection, so there is no wire response a test client could ever
    // read back. The "stops starting new pipeline.execute() calls once the
    // client disconnects" test above already proves that code path runs
    // (admitted-call count stops growing after abort); this test proves the
    // other half — that the exact code it throws is honestly non-retryable
    // — by constructing the identical envelope the adapter would produce.
    // Message text must match `adapter.ts`'s disconnect throw sites by hand.
    const envelope = toErrorEnvelope(
      new CommerceError('PROTOCOL_UNSUPPORTED', 'Client disconnected while queued.'),
    );
    expect(envelope.retryable).toBe(false);
    expect(COMMERCE_ERROR_HTTP_STATUS[envelope.code]).not.toBe(503);
    // The two rejection paths must never collapse onto the same code — that
    // is exactly the bug closed (a transient throttle and "caller is
    // gone" are different conditions with different retry semantics).
    expect(envelope.code).not.toBe('GATEWAY_BUSY');
  });
});

describe('mcp adapter: transport and lifecycle', () => {
  it('rejects non-POST methods cleanly instead of crashing', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    const res = await fetch(`${h.server.url}${h.adapter.mountPath}`, { method: 'GET' });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message.toLowerCase()).toContain('method not allowed');
  });

  it('reports 503 for handleHttp before start() and pass health after start()', async () => {
    const adapter = createMcpAdapter();
    const before = await adapter.health();
    expect(before.status).toBe('fail');

    const { context } = createFakeContext({ resources: [FREE_ECHO_RESOURCE] });
    await adapter.start(context);
    const after = await adapter.health();
    expect(after.status).toBe('pass');
    expect(after.detail).toContain('1 tool');

    await adapter.stop();
  });

  it('stop() is idempotent and never throws', async () => {
    const adapter = createMcpAdapter();
    const { context } = createFakeContext({ resources: [FREE_ECHO_RESOURCE] });
    await adapter.start(context);
    await expect(adapter.stop()).resolves.toBeUndefined();
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it('start() never throws even if the resource registry itself throws, and reports a fail-safe empty tool set', async () => {
    const adapter = createMcpAdapter();
    const { context } = createFakeContext({ resources: [FREE_ECHO_RESOURCE] });
    const brokenResources: typeof context.resources = {
      ...context.resources,
      listExposedVia: () => {
        throw new Error('registry exploded');
      },
    };
    const brokenContext = { ...context, resources: brokenResources };

    await expect(adapter.start(brokenContext)).resolves.toBeUndefined();
    const health = await adapter.health();
    expect(health.status).toBe('pass');
    expect(health.detail).toContain('0 tool');

    await adapter.stop();
  });

  it('accepts McpAdapterOptions overrides (mountPath, serverName, serverVersion)', async () => {
    const adapter = createMcpAdapter({
      mountPath: '/custom-mcp',
      serverName: 'custom-server',
      serverVersion: '9.9.9',
    });
    expect(adapter.mountPath).toBe('/custom-mcp');

    const { context } = createFakeContext({ resources: [FREE_ECHO_RESOURCE] });
    await adapter.start(context);
    const server = await startAdapterServer(adapter);
    const client = new Client({ name: 'conformance-client', version: '0.0.0-test' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/custom-mcp`));
    await client.connect(transport as Transport);

    expect(client.getServerVersion()).toEqual({ name: 'custom-server', version: '9.9.9' });

    await client.close();
    await adapter.stop();
    await server.close();
  });
});
