import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { CommerceResource } from '../../../src/core';
import { createMcpAdapter } from '../../../src/protocols/mcp/adapter';
import { buildInputSchema, buildToolDescription } from '../../../src/protocols/mcp/tool-mapping';
import { createFakeContext } from '../../conformance/mcp/fakes';
import { FREE_ECHO_RESOURCE } from '../../conformance/mcp/fixtures';

// Closed, as config closes every resource input schema by default
const GATED_RESOURCE: CommerceResource = {
  id: 'gated-report',
  name: 'Gated Report',
  description: 'A report behind an AP2 mandate.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  handler: { type: 'http', method: 'POST', url: 'http://127.0.0.1:9/report' },
  pricing: { type: 'fixed', amount: '0.05', currency: 'USDC' },
  exposedVia: ['mcp'],
  paymentMethods: ['x402'],
  authorization: { required: ['ap2'] },
};

const UNGATED_RESOURCE: CommerceResource = {
  ...GATED_RESOURCE,
  id: 'plain-report',
  authorization: { required: [] },
};

describe('buildInputSchema', () => {
  it('declares _authorization, so a validating client can send the mandate a closed schema would refuse', () => {
    const validate = new Ajv2020({ strict: false }).compile(buildInputSchema(GATED_RESOURCE));
    const args = {
      city: 'Berlin',
      _payment: 'proof',
      _authorization: { method: 'ap2', payload: 'mandate' },
    };

    expect(validate(args)).toBe(true);
    expect(validate({ ...args, _authorization: { method: 'other', payload: 'x' } })).toBe(false);
    expect(buildToolDescription(GATED_RESOURCE)).toContain('"_authorization"');
  });

  it('leaves _authorization out when the resource requires no authorization', () => {
    const schema = buildInputSchema(UNGATED_RESOURCE) as { properties: Record<string, unknown> };
    const validate = new Ajv2020({ strict: false }).compile(schema);

    expect(schema.properties['_authorization']).toBeUndefined();
    expect(validate({ city: 'Berlin', _authorization: { method: 'ap2', payload: 'x' } })).toBe(
      false,
    );
    expect(buildToolDescription(UNGATED_RESOURCE)).not.toContain('_authorization');
  });
});

// The private permit methods, reached directly: the barging they prevent
// happens between a release and the woken waiter resuming, which no call
// through handleHttp can schedule deterministically
interface PermitInternals {
  acquireToolCallSlot(signal: AbortSignal): Promise<void>;
  releaseToolCallSlot(): void;
}

describe('MCP tool-call permits', () => {
  it('hands a released permit to the oldest waiter, so a later caller cannot overtake it', async () => {
    const permits = createMcpAdapter() as unknown as PermitInternals;
    const signal = new AbortController().signal;
    for (let i = 0; i < 8; i++) await permits.acquireToolCallSlot(signal);

    const order: string[] = [];
    const queued = permits.acquireToolCallSlot(signal).then(() => order.push('queued'));
    permits.releaseToolCallSlot();
    const late = permits.acquireToolCallSlot(signal).then(() => order.push('late'));

    await queued;
    expect(order).toEqual(['queued']);

    permits.releaseToolCallSlot();
    await late;
    expect(order).toEqual(['queued', 'late']);
  });

  it('passes the permit on when the queued caller has disconnected', async () => {
    const permits = createMcpAdapter() as unknown as PermitInternals;
    const live = new AbortController().signal;
    for (let i = 0; i < 8; i++) await permits.acquireToolCallSlot(live);

    const gone = new AbortController();
    const abandoned = permits.acquireToolCallSlot(gone.signal);
    const next = permits.acquireToolCallSlot(live);
    gone.abort();
    permits.releaseToolCallSlot();

    await expect(abandoned).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
    await expect(next).resolves.toBeUndefined();
  });
});

// Reached directly as well: once the client has disconnected, no response
// carries the call's result back for a test to observe
interface ToolCallInternals {
  handleToolCall(
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
}

describe('MCP tool call whose client has disconnected', () => {
  it('starts no pipeline run and answers with a non-retryable code, not GATEWAY_BUSY', async () => {
    const adapter = createMcpAdapter();
    const { context, pipeline } = createFakeContext({ resources: [FREE_ECHO_RESOURCE] });
    await adapter.start(context);
    const calls = adapter as unknown as ToolCallInternals;
    const gone = new AbortController();
    gone.abort();

    const result = await calls.handleToolCall('echo', { message: 'hi' }, undefined, gone.signal);

    expect(pipeline.requests).toHaveLength(0);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'PROTOCOL_UNSUPPORTED', retryable: false },
    });

    // The same call from a connected client does reach the pipeline
    await calls.handleToolCall('echo', { message: 'hi' }, undefined, new AbortController().signal);
    expect(pipeline.requests).toHaveLength(1);
  });
});
