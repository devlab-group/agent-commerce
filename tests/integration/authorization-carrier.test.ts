/**
 * The same authorization proof over all three transports.
 *
 * The carrier differs per surface: a header over HTTP, a reserved input field
 * over MCP and A2A. All three have to reach the pipeline as the same
 * `AuthorizationSubmission` with the proof untouched, and a per-adapter copy
 * of the extraction is the drift this catches. So every assertion runs
 * against the real gateway with the real adapters mounted, not against the
 * extraction helper on its own.
 *
 * No authorization provider is configured, so nothing verifies the proof.
 * What is asserted is transport behavior: it reaches the pipeline intact, it
 * never reaches the resource input, and a malformed envelope is refused before
 * the pipeline runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../src/config';
import type { BackendExecutor, CanonicalRequest, ExecutionPipeline } from '../../src/core';
import {
  AUTHORIZATION_HEADER,
  AUTHORIZATION_INPUT_FIELD,
  MAX_AUTHORIZATION_HEADER_BYTES,
} from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createA2aAdapter } from '../../src/protocols/a2a';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createFakeStore } from '../unit/gateway/helpers';

process.env['NODE_ENV'] = 'test';

const PROOF = 'eyJhbGciOiJFUzI1NiJ9.checkout-mandate~disclosure-0~';
const ENVELOPE = { method: 'ap2', payload: PROOF };

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
      acp: { enabled: false, mountPath: '/acp' },
    },
    resources: [
      {
        id: 'weather_basic',
        name: 'Basic Weather',
        description: 'Current weather for a city.',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          // Closed schema: if a reserved field survived extraction it would
          // fail here as INPUT_INVALID rather than reaching the backend
          additionalProperties: false,
        },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
        pricing: { type: 'free' },
        exposedVia: ['http', 'mcp', 'a2a'],
        paymentMethods: [],
      },
    ],
    payments: {},
  };
}

const backendInputs: unknown[] = [];
const backend: BackendExecutor = {
  async call(_handler, request) {
    backendInputs.push(request.input);
    return { status: 200, body: { forecast: 'sunny' }, headers: {}, durationMs: 1 };
  },
};

// Captures the exact CanonicalRequest each surface built, without re-routing
function spyOnPipeline(gw: GatewayInstance): CanonicalRequest[] {
  const captured: CanonicalRequest[] = [];
  const original = gw.pipeline.execute.bind(gw.pipeline);
  (gw.pipeline as { execute: ExecutionPipeline['execute'] }).execute = async (request) => {
    captured.push(request);
    return original(request);
  };
  return captured;
}

async function startGateway(): Promise<GatewayInstance> {
  backendInputs.length = 0;
  gateway = await createGateway({
    config: config(),
    store: createFakeStore(),
    paymentProviders: [],
    protocolAdapters: [createMcpAdapter(), createA2aAdapter()],
    backend,
  });
  return gateway;
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// --- one call per surface --------------------------------------------------

async function callHttp(
  gw: GatewayInstance,
  authorization?: string,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await gw.server.inject({
    method: 'POST',
    url: '/api/resources/weather_basic/invoke',
    headers: {
      'content-type': 'application/json',
      ...(authorization !== undefined ? { [AUTHORIZATION_HEADER]: authorization } : {}),
    },
    payload: { city: 'Berlin' },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

interface McpToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: { code?: string };
}

async function callMcp(gw: GatewayInstance, args: Record<string, unknown>): Promise<McpToolResult> {
  const res = await gw.server.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'weather_basic', arguments: { city: 'Berlin', ...args } },
    },
  });
  // The adapter answers over Streamable HTTP, which can frame the reply as a
  // single SSE event rather than a bare JSON body
  const raw = res.body.startsWith('event:')
    ? (res.body.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)
    : res.body;
  return (JSON.parse(raw) as { result: McpToolResult }).result;
}

interface A2aTaskResult {
  result?: { task?: { artifacts: { parts: { data: Record<string, unknown> }[] }[] } };
}

async function callA2a(
  gw: GatewayInstance,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const res = await gw.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: {
        message: {
          role: 'ROLE_USER',
          messageId: 'msg-1',
          parts: [
            {
              data: { resource: 'weather_basic', input: { city: 'Berlin', ...input } },
              mediaType: 'application/json',
            },
          ],
        },
      },
    }),
  });
  const body = res.json<A2aTaskResult>();
  return body.result?.task?.artifacts[0]?.parts[0]?.data;
}

// --- tests -----------------------------------------------------------------

describe('generic authorization carrier across every surface', () => {
  it('normalizes an HTTP header, an MCP argument and an A2A input field to the same submission', async () => {
    const gw = await startGateway();
    const captured = spyOnPipeline(gw);

    await callHttp(gw, encodeHeader(ENVELOPE));
    await callMcp(gw, { [AUTHORIZATION_INPUT_FIELD]: ENVELOPE });
    await callA2a(gw, { [AUTHORIZATION_INPUT_FIELD]: ENVELOPE });

    expect(captured.map((r) => r.protocol)).toEqual(['http', 'mcp', 'a2a']);
    for (const request of captured) {
      expect(request.authorization).toEqual({ method: 'ap2', payload: PROOF });
    }
  });

  it('keeps the reserved field out of the resource input on every surface', async () => {
    const gw = await startGateway();
    const captured = spyOnPipeline(gw);

    const http = await callHttp(gw, encodeHeader(ENVELOPE));
    const mcp = await callMcp(gw, { [AUTHORIZATION_INPUT_FIELD]: ENVELOPE });
    const a2a = await callA2a(gw, { [AUTHORIZATION_INPUT_FIELD]: ENVELOPE });

    expect(http.statusCode).toBe(200);
    expect(mcp.isError).not.toBe(true);
    expect(a2a).toEqual({ forecast: 'sunny' });

    // Delivery alone proves nothing: the pipeline strips reserved fields again
    // before validation. The input each adapter handed over is the check.
    for (const request of captured) {
      expect(request.input).toEqual({ city: 'Berlin' });
    }
    // And the merchant backend never sees a gateway-reserved field
    expect(backendInputs).toEqual([{ city: 'Berlin' }, { city: 'Berlin' }, { city: 'Berlin' }]);
  });

  it('leaves a request carrying no authorization exactly as it was', async () => {
    const gw = await startGateway();
    const captured = spyOnPipeline(gw);

    const http = await callHttp(gw);
    const mcp = await callMcp(gw, {});
    const a2a = await callA2a(gw, {});

    expect(http.statusCode).toBe(200);
    expect(mcp.isError).not.toBe(true);
    expect(a2a).toEqual({ forecast: 'sunny' });
    for (const request of captured) {
      expect(request.authorization).toBeUndefined();
    }
  });

  it('refuses a malformed envelope before the pipeline runs, on every surface', async () => {
    const gw = await startGateway();
    const captured = spyOnPipeline(gw);

    const http = await callHttp(gw, encodeHeader({ method: 'ap2' }));
    expect(http.statusCode).toBe(403);
    expect(http.body).toMatchObject({ code: 'AUTHORIZATION_INVALID', retryable: false });

    const mcp = await callMcp(gw, { [AUTHORIZATION_INPUT_FIELD]: 'a-bare-string' });
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent?.code).toBe('AUTHORIZATION_INVALID');

    const a2a = await callA2a(gw, {
      [AUTHORIZATION_INPUT_FIELD]: { method: 'ap3', payload: PROOF },
    });
    expect(a2a?.['code']).toBe('AUTHORIZATION_INVALID');

    expect(captured).toHaveLength(0);
    expect(backendInputs).toEqual([]);
  });

  it('refuses an oversized HTTP carrier deterministically', async () => {
    const gw = await startGateway();
    const captured = spyOnPipeline(gw);

    // A well-formed envelope, so only the size limit can refuse it
    const oversized = encodeHeader({
      ...ENVELOPE,
      payload: 'x'.repeat(MAX_AUTHORIZATION_HEADER_BYTES),
    });
    const { statusCode, body } = await callHttp(gw, oversized);

    expect(statusCode).toBe(403);
    expect(body).toMatchObject({ code: 'AUTHORIZATION_INVALID' });
    expect((body as { message: string }).message).toContain(String(MAX_AUTHORIZATION_HEADER_BYTES));
    expect(captured).toHaveLength(0);
  });

  it('never reports an authorization failure as a payment failure', async () => {
    // A 402 would tell an auto-paying client to spend money on a request that
    // was never going to be delivered
    const gw = await startGateway();

    const { statusCode, body } = await callHttp(gw, encodeHeader({ method: 'ap2', payload: 42 }));

    expect(statusCode).toBe(403);
    expect(body).toMatchObject({ code: 'AUTHORIZATION_INVALID', retryable: false });
  });
});
