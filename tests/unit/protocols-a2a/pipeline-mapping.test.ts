/**
 * The A2A adapter against a spied `ExecutionPipeline`: one accepted invocation
 * must produce exactly one canonical execution, carrying the resource id and
 * input the caller sent and nothing the adapter invented.
 */
import { describe, expect, it, vi } from 'vitest';
import { createResourceRegistry } from '../../../src/core/execution/index.js';
import type {
  CanonicalRequest,
  Clock,
  CommerceReceipt,
  CommerceResource,
  EventSink,
  ExecutionOutcome,
  ExecutionPipeline,
  IdGenerator,
  Logger,
  ProtocolAdapterContext,
  ResourceRegistry,
} from '../../../src/core/index.js';
import { CommerceError, PAYMENT_INPUT_FIELD } from '../../../src/core/index.js';
import { createA2aAdapter } from '../../../src/protocols/a2a/index.js';

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

const receipt: CommerceReceipt = {
  id: 'rcpt-1',
  requestId: 'a2a-1',
  resourceId: 'market_report',
  protocol: 'a2a',
  deliveredAt: '2026-01-01T00:00:00.000Z',
  backendStatus: 200,
  durationMs: 3,
};

const free: CommerceResource = {
  id: 'weather_basic',
  name: 'Basic Weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
  pricing: { type: 'free' },
  exposedVia: ['a2a'],
  paymentMethods: [],
};

const paid: CommerceResource = {
  id: 'market_report',
  name: 'Premium Market Report',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
  handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  exposedVia: ['a2a'],
  paymentMethods: ['x402'],
};

const mcpOnly: CommerceResource = { ...free, id: 'mcp_only', exposedVia: ['mcp'] };

const delivered: ExecutionOutcome = {
  kind: 'delivered',
  requestId: 'a2a-1',
  resourceId: 'market_report',
  backendStatus: 200,
  body: { price: 42 },
  receipt,
  durationMs: 3,
};

function setup(outcome: ExecutionOutcome | CommerceError = delivered) {
  const execute = vi.fn(async (_request: CanonicalRequest): Promise<ExecutionOutcome> => {
    if (outcome instanceof CommerceError) throw outcome;
    return outcome;
  });
  const context: ProtocolAdapterContext = {
    pipeline: { execute } as ExecutionPipeline,
    resources: createResourceRegistry([free, paid, mcpOnly]) as ResourceRegistry,
    events: { emit: async () => {} } as EventSink,
    logger: NOOP_LOGGER,
    clock,
    ids: (() => {
      let n = 0;
      return { next: (prefix?: string) => `${prefix ?? 'id'}-${++n}` };
    })() as IdGenerator,
    publicBaseUrl: 'https://gateway.example.com',
  };
  return { execute, context };
}

/** The one canonical request the pipeline was handed. */
function firstRequest(execute: { mock: { calls: unknown[][] } }): CanonicalRequest {
  const request = execute.mock.calls[0]?.[0];
  if (request === undefined) throw new Error('pipeline was never called');
  return request as CanonicalRequest;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Drives the mount handler with a minimal fake req/res pair. */
async function send(
  adapter: ReturnType<typeof createA2aAdapter>,
  data: unknown,
): Promise<JsonRpcResponse> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'SendMessage',
    params: {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-1',
        parts: [{ data, mediaType: 'application/json' }],
      },
    },
  });
  let body = '';
  const res = {
    headersSent: false,
    writeHead() {
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return res;
    },
  };
  const req = Object.assign(
    (async function* () {
      yield Buffer.from(payload, 'utf8');
    })(),
    { method: 'POST', headers: { 'a2a-version': '1.0' } },
  );
  await adapter.handleHttp(req as never, res as never);
  return JSON.parse(body) as JsonRpcResponse;
}

describe('A2A SendMessage onto the execution pipeline', () => {
  it('runs exactly one execution per accepted invocation, with the canonical protocol', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });

    expect(execute).toHaveBeenCalledTimes(1);
    const request = firstRequest(execute);
    expect(request.protocol).toBe('a2a');
    expect(request.resourceId).toBe('market_report');
    expect(request.input).toEqual({ symbol: 'ETH' });
    expect(request.requestId).toMatch(/^a2a-/);
    expect(response.result?.['kind']).toBe('delivered');
  });

  it('preserves the input verbatim, including nested values', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const input = { symbol: 'ETH', filters: { since: '2026-01-01', tags: ['a', 'b'] }, depth: 3 };
    await send(adapter, { resource: 'market_report', input });

    expect(firstRequest(execute).input).toEqual(input);
  });

  it('lifts the reserved payment field into the canonical payment submission', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    await send(adapter, {
      resource: 'market_report',
      input: { symbol: 'ETH', [PAYMENT_INPUT_FIELD]: 'base64-proof' },
    });

    const request = firstRequest(execute);
    expect(request.payment).toEqual({ method: 'x402', payload: 'base64-proof' });
    // The proof never reaches the merchant backend as resource input.
    expect(request.input).toEqual({ symbol: 'ETH' });
  });

  it('sends no payment for a free resource, whatever the caller put in the field', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    await send(adapter, {
      resource: 'weather_basic',
      input: { city: 'Berlin', [PAYMENT_INPUT_FIELD]: 'base64-proof' },
    });

    expect(firstRequest(execute).payment).toBeUndefined();
  });

  it('never executes a resource that is not exposed over a2a', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'mcp_only', input: {} });

    expect(execute).not.toHaveBeenCalled();
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain('Unknown canonical resource');
  });

  it('answers an unknown resource exactly as it answers a hidden one', async () => {
    const { context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const hidden = await send(adapter, { resource: 'mcp_only', input: {} });
    const missing = await send(adapter, { resource: 'does_not_exist', input: {} });

    expect(hidden.error?.code).toBe(missing.error?.code);
    expect(hidden.error?.message.replace('mcp_only', 'X')).toBe(
      missing.error?.message.replace('does_not_exist', 'X'),
    );
  });

  it('returns the payment challenge the pipeline built, not one of its own', async () => {
    const { context } = setup({
      kind: 'payment-required',
      requestId: 'a2a-1',
      resourceId: 'market_report',
      requirement: {
        id: 'req-1',
        requestId: 'a2a-1',
        resourceId: 'market_report',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        destination: '0x1111111111111111111111111111111111111111',
        network: 'eip155:84532',
        asset: '0x2222222222222222222222222222222222222222',
        expiresAt: '2026-01-01T00:05:00.000Z',
        challenge: { provider: 'x402', version: '2', accepts: [{ scheme: 'exact' }] },
      },
    });
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });

    expect(response.error).toBeUndefined();
    expect(response.result?.['payment']).toMatchObject({ amount: '0.01', currency: 'USDC' });
  });

  it.each([
    [
      'a rejected payment',
      new CommerceError('PAYMENT_INVALID', 'Payment proof is invalid.'),
      -32603,
    ],
    ['a backend failure', new CommerceError('BACKEND_ERROR', 'Backend returned 502.'), -32603],
    ['invalid input', new CommerceError('INPUT_INVALID', 'Input does not match schema.'), -32602],
  ])('maps %s thrown by the pipeline onto a JSON-RPC error', async (_label, error, code) => {
    const { execute, context } = setup(error);
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe(code);
  });

  it('executes nothing when the envelope is rejected', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    await send(adapter, { input: { symbol: 'ETH' } });
    await send(adapter, { resource: '' });

    expect(execute).not.toHaveBeenCalled();
  });
});

/**
 * A negative that no runtime test can observe: the adapter reaching a merchant
 * backend on its own would simply look like a working call here, because the
 * pipeline fake never notices it was bypassed. Assert it at the source.
 */
describe('A2A adapter is not a client of anything', () => {
  it('contains no HTTP client call, no payment verification and no price arithmetic', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = new URL('../../../src/protocols/a2a/', import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const source = await readFile(new URL(file, dir), 'utf8');
      expect(source, `${file} must not call fetch`).not.toMatch(/\bfetch\s*\(/);
      // `import type { IncomingMessage }` is fine; a value import of a client
      // is not.
      expect(source, `${file} must not import an HTTP client`).not.toMatch(
        /^import\s+(?!type)[^;]*from\s+'node:(http|https|net|tls)'/m,
      );
      expect(source, `${file} must not import undici or axios`).not.toMatch(
        /from\s+'(undici|axios|got|node-fetch)'/,
      );
      expect(source, `${file} must not verify or settle payments`).not.toMatch(
        /\b(verifyPayment|settlePayment|createPaymentProvider)\b/,
      );
    }
  });
});
