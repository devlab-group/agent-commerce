/**
 * Exercise the adapter with a v2 client pinned to `2026-07-28`. The v1
 * conformance tests cover the SDK's 2025-era fallback.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalRequest, ExecutionOutcome } from '../../../src/core';
import { createMcpAdapter } from '../../../src/protocols/mcp';
import { createFakeContext, type FakeExecutionPipeline } from './fakes';
import { FREE_ECHO_RESOURCE, PAID_WEATHER_RESOURCE } from './fixtures';
import { EXPECTED_MCP_MODERN_PROTOCOL_REVISION } from './protocol-revision.fixture';
import { type RunningAdapterServer, startAdapterServer } from './support';

interface Harness {
  readonly client: Client;
  readonly pipeline: FakeExecutionPipeline;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

async function setup(resources: Parameters<typeof createFakeContext>[0]['resources']) {
  const adapter = createMcpAdapter();
  const { context, pipeline } = createFakeContext({ resources });
  await adapter.start(context);
  const server: RunningAdapterServer = await startAdapterServer(adapter);
  const client = new Client(
    { name: 'modern-client', version: '0.0.0-test' },
    // Pin the revision so connection fails if discovery does not offer it
    { versionNegotiation: { mode: { pin: EXPECTED_MCP_MODERN_PROTOCOL_REVISION } } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  const harness: Harness = {
    client,
    pipeline,
    close: async () => {
      await client.close().catch(() => {});
      await adapter.stop().catch(() => {});
      await server.close().catch(() => {});
    },
  };
  harnesses.push(harness);
  return harness;
}

function delivered(request: CanonicalRequest): ExecutionOutcome {
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
      deliveredAt: '2026-10-04T00:00:00.000Z',
      backendStatus: 200,
    },
    durationMs: 1,
  };
}

describe('mcp adapter: 2026-07-28 revision', () => {
  it('negotiates the modern revision, which server/discover offers', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);

    expect(h.client.getNegotiatedProtocolVersion()).toBe(EXPECTED_MCP_MODERN_PROTOCOL_REVISION);
    // Discovery advertises the modern revision; legacy clients initialize
    const discovered = await h.client.discover();
    expect(discovered.supportedVersions).toContain(EXPECTED_MCP_MODERN_PROTOCOL_REVISION);
  });

  it('lists tools with the cache fields the revision requires', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);

    const listed = await h.client.listTools();

    expect(listed.tools.map((t) => t.name)).toEqual(['echo']);
    expect(listed).toMatchObject({ ttlMs: expect.any(Number), cacheScope: expect.any(String) });
  });

  it('calls a tool through the pipeline', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);
    h.pipeline.handler = delivered;

    const result = await h.client.callTool({ name: 'echo', arguments: { message: 'hi' } });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ echoed: 'hi' });
    expect(h.pipeline.requests).toHaveLength(1);
  });

  it('answers a paid call without a proof with the payment-required result', async () => {
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
        challenge: { provider: 'x402', version: '2', accepts: [{ scheme: 'exact' }] },
      },
    });

    const result = await h.client.callTool({ name: 'get-weather', arguments: { city: 'Oslo' } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('reads an x402 proof from _meta in a modern tool call', async () => {
    const h = await setup([PAID_WEATHER_RESOURCE]);
    h.pipeline.handler = delivered;
    const payload = { x402Version: 2, accepted: { scheme: 'exact' }, payload: {} };

    await h.client.callTool({
      name: 'get-weather',
      arguments: { city: 'Oslo' },
      _meta: { 'x402/payment': payload },
    });

    expect(h.pipeline.requests[0]?.payment).toEqual({
      method: 'x402',
      payload: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    });
  });

  it('refuses an unknown tool with -32602', async () => {
    const h = await setup([FREE_ECHO_RESOURCE]);

    await expect(
      h.client.callTool({ name: 'does-not-exist', arguments: {} }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    expect(h.pipeline.requests).toHaveLength(0);
  });
});
