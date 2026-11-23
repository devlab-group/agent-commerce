/**
 * The A2A adapter against a spied `ExecutionPipeline`: one accepted invocation
 * must produce exactly one canonical execution, carrying the resource id and
 * input the caller sent and nothing the adapter invented
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  CanonicalRequest,
  Clock,
  CommerceReceipt,
  CommerceResource,
  DeliveredOutcome,
  EventSink,
  ExecutionOutcome,
  ExecutionPipeline,
  IdGenerator,
  Logger,
  ProtocolAdapterContext,
  ReceiptStore,
  ResourceRegistry,
  TaskRecord,
} from '../../../src/core';
import { CommerceError, DELIVERY_SUMMARY_META_KEY, PAYMENT_INPUT_FIELD } from '../../../src/core';
import { createResourceRegistry } from '../../../src/core/execution';
import { createA2aAdapter } from '../../../src/protocols/a2a';
import type { A2aTask } from '../../../src/protocols/a2a/types';

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

const paymentRequired: ExecutionOutcome = {
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
    network: 'eip155:31337',
    asset: '0x2222222222222222222222222222222222222222',
    expiresAt: '2026-01-01T00:05:00.000Z',
    challenge: { provider: 'x402', version: '2', accepts: [{ scheme: 'exact' }] },
  },
};

const delivered: ExecutionOutcome = {
  kind: 'delivered',
  requestId: 'a2a-1',
  resourceId: 'market_report',
  backendStatus: 200,
  body: { price: 42 },
  receipt,
  durationMs: 3,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// An Error is thrown by the pipeline; anything else is returned as its outcome
function setup(outcome: ExecutionOutcome | Error = delivered) {
  const execute = vi.fn(async (_request: CanonicalRequest): Promise<ExecutionOutcome> => {
    if (outcome instanceof Error) throw outcome;
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

// The one canonical request the pipeline was handed
function firstRequest(execute: { mock: { calls: unknown[][] } }): CanonicalRequest {
  const request = execute.mock.calls[0]?.[0];
  if (request === undefined) throw new Error('pipeline was never called');
  return request as CanonicalRequest;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: { task?: A2aTask };
  error?: { code: number; message: string };
}

// The terminal task a commerce outcome comes back as
function task(response: JsonRpcResponse): A2aTask {
  const value = response.result?.task;
  if (value === undefined) {
    throw new Error(`expected a task, got ${JSON.stringify(response)}`);
  }
  return value;
}

// The single data payload inside the task's single artifact
function artifactData(response: JsonRpcResponse): Record<string, unknown> {
  const part = task(response).artifacts[0]?.parts[0];
  if (part === undefined) throw new Error('task carried no artifact part');
  expect(part.mediaType).toBe('application/json');
  return part.data;
}

function sendMessagePayload(data: unknown): string {
  return JSON.stringify({
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
}

// Drives the mount handler with a minimal fake req/res pair
async function post(
  adapter: ReturnType<typeof createA2aAdapter>,
  payload: string,
): Promise<{ status: number; body: JsonRpcResponse }> {
  let status = 0;
  let body = '';
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
  const req = Object.assign(
    (async function* () {
      yield Buffer.from(payload, 'utf8');
    })(),
    { method: 'POST', headers: { 'a2a-version': '1.0' } },
  );
  await adapter.handleHttp(req as never, res as never);
  return { status, body: JSON.parse(body) as JsonRpcResponse };
}

async function send(
  adapter: ReturnType<typeof createA2aAdapter>,
  data: unknown,
): Promise<JsonRpcResponse> {
  return (await post(adapter, sendMessagePayload(data))).body;
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
    expect(task(response).status.state).toBe('TASK_STATE_COMPLETED');
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
    // The proof never reaches the merchant backend as resource input
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
    expect(task(response).status.state).toBe('TASK_STATE_FAILED');
    expect(artifactData(response)['code']).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers an unknown resource exactly as it answers a hidden one', async () => {
    const { context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const hidden = artifactData(await send(adapter, { resource: 'mcp_only', input: {} }));
    const missing = artifactData(await send(adapter, { resource: 'does_not_exist', input: {} }));

    expect(hidden['code']).toBe(missing['code']);
    expect(String(hidden['message']).replace('mcp_only', 'X')).toBe(
      String(missing['message']).replace('does_not_exist', 'X'),
    );
  });

  it('returns the payment challenge the pipeline built, not one of its own', async () => {
    const { context } = setup(paymentRequired);
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });

    expect(response.error).toBeUndefined();
    expect(task(response).status.state).toBe('TASK_STATE_FAILED');
    const data = artifactData(response);
    expect(data['status']).toBe('payment-required');
    expect(data['payment']).toEqual({
      provider: 'x402',
      version: '2',
      amount: '0.01',
      currency: 'USDC',
      destination: '0x1111111111111111111111111111111111111111',
      network: 'eip155:31337',
      asset: '0x2222222222222222222222222222222222222222',
      expiresAt: '2026-01-01T00:05:00.000Z',
      accepts: [{ scheme: 'exact' }],
    });
  });

  it.each([
    ['a rejected payment', new CommerceError('PAYMENT_INVALID', 'Payment proof is invalid.')],
    ['a backend failure', new CommerceError('BACKEND_ERROR', 'Backend returned 502.')],
    ['invalid input', new CommerceError('INPUT_INVALID', 'Input does not match schema.')],
  ])(
    'answers %s thrown by the pipeline with a failed task, not a JSON-RPC error',
    async (_label, error) => {
      const { execute, context } = setup(error);
      const adapter = createA2aAdapter();
      await adapter.start(context);

      const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(response.error).toBeUndefined();
      expect(task(response).status.state).toBe('TASK_STATE_FAILED');
      expect(artifactData(response)['code']).toBe(error.code);
      // The failed task is kept like any other answer
      const read = await post(
        adapter,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-2',
          method: 'GetTask',
          params: { id: task(response).id },
        }),
      );
      expect(read.body.result).toEqual(task(response));
    },
  );

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
      // is not
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

describe('the task record of a blocking answer', () => {
  const PROOF = { [PAYMENT_INPUT_FIELD]: 'base64-proof' };
  const charged = { payment: { status: 'settled', provider: 'x402' } };
  const paidDelivery = {
    ...delivered,
    payment: { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' },
  } as ExecutionOutcome;
  const fail = (code: CommerceError['code'], details?: Record<string, unknown>) =>
    new CommerceError(code, 'refused', details ? { details } : {});

  // Evictable only when nothing was charged for the answer
  it.each([
    ['a free delivery', true, delivered, {}],
    ['a paid delivery', false, paidDelivery, PROOF],
    ['a payment-required answer', true, paymentRequired, {}],
    ['a failure without a proof', true, fail('BACKEND_ERROR'), {}],
    ['a proof the provider rejected', true, fail('PAYMENT_INVALID'), PROOF],
    ['a replayed proof', true, fail('PAYMENT_REPLAYED'), PROOF],
    ['input refused before pricing', true, fail('INPUT_INVALID'), PROOF],
    ['a refused mandate', true, fail('AUTHORIZATION_INVALID'), PROOF],
    ['a missing mandate', true, fail('AUTHORIZATION_REQUIRED'), PROOF],
    ['a backend failure that abandoned settlement', true, fail('BACKEND_TIMEOUT'), PROOF],
    ['a backend failure after an upfront settlement', false, fail('BACKEND_ERROR', charged), PROOF],
    ['a failed settlement', false, fail('PAYMENT_SETTLEMENT_FAILED'), PROOF],
    ['a provider outage after a proof', false, fail('PAYMENT_PROVIDER_UNAVAILABLE'), PROOF],
  ] as const)('marks %s evictable: %s', async (_label, evictable, outcome, input) => {
    const written: TaskRecord[] = [];
    const store = {
      putTaskRecord: async (record: TaskRecord) => written.push(record) > 0,
      getTaskRecord: async () => undefined,
      listTaskRecords: async () => [],
    } as unknown as ReceiptStore;
    const adapter = createA2aAdapter({ store });
    await adapter.start(setup(outcome).context);

    await send(adapter, { resource: 'market_report', input });

    expect(written.map((record) => record.evictable === true)).toEqual([evictable]);
  });

  it('marks an unknown resource evictable', async () => {
    const written: TaskRecord[] = [];
    const store = {
      putTaskRecord: async (record: TaskRecord) => written.push(record) > 0,
      getTaskRecord: async () => undefined,
      listTaskRecords: async () => [],
    } as unknown as ReceiptStore;
    const adapter = createA2aAdapter({ store });
    await adapter.start(setup().context);

    await send(adapter, { resource: 'no_such_resource', input: PROOF });

    expect(written.map((record) => record.evictable)).toEqual([true]);
  });
});

describe('an answered task the store does not keep', () => {
  function getTask(id: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 'req-2', method: 'GetTask', params: { id } });
  }

  function loggingSetup(outcome: ExecutionOutcome = delivered) {
    const { context } = setup(outcome);
    const warn = vi.fn();
    const error = vi.fn();
    const logger: Logger = { ...NOOP_LOGGER, warn, error };
    return { context: { ...context, logger }, warn, error };
  }

  const paidDelivery: ExecutionOutcome = {
    ...delivered,
    payment: { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' },
  } as ExecutionOutcome;

  it('replaces the oldest free answer with a new one when the store is full', async () => {
    const adapter = createA2aAdapter({ tasks: { maxRetained: 1 } });
    await adapter.start(setup().context);
    const first = task(await send(adapter, { resource: 'market_report', input: {} }));

    const second = task(await send(adapter, { resource: 'market_report', input: {} }));

    expect((await post(adapter, getTask(first.id))).body.error?.code).toBe(-32001);
    expect((await post(adapter, getTask(second.id))).body.result).toEqual(second);
  });

  it('is returned but not kept when paid answers fill the store, and the gateway logs a warning', async () => {
    const { context, warn } = loggingSetup(paidDelivery);
    const adapter = createA2aAdapter({ tasks: { maxRetained: 1 } });
    await adapter.start(context);
    const kept = task(await send(adapter, { resource: 'market_report', input: {} }));

    const refused = task(await send(adapter, { resource: 'market_report', input: {} }));

    expect(refused.status.state).toBe('TASK_STATE_COMPLETED');
    expect((await post(adapter, getTask(refused.id))).body.error?.code).toBe(-32001);
    expect((await post(adapter, getTask(kept.id))).body.result).toEqual(kept);
    expect(warn).toHaveBeenCalledWith(
      { state: 'TASK_STATE_COMPLETED' },
      'a2a adapter: task not retained: the task store is full',
    );
  });

  it('is returned but not kept when the store write fails, and the gateway logs an error', async () => {
    const { context, error } = loggingSetup();
    const store = {
      putTaskRecord: async () => {
        throw new CommerceError('STORAGE_ERROR', 'disk full');
      },
      getTaskRecord: async () => undefined,
      listTaskRecords: async () => [],
    } as unknown as ReceiptStore;
    const adapter = createA2aAdapter({ store });
    await adapter.start(context);

    const answered = task(await send(adapter, { resource: 'market_report', input: {} }));

    expect(answered.status.state).toBe('TASK_STATE_COMPLETED');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'TASK_STATE_COMPLETED' }),
      'a2a adapter: task not retained',
    );
    // No task or context id reaches the log
    expect(JSON.stringify(error.mock.calls)).not.toContain(answered.id);
    expect(JSON.stringify(error.mock.calls)).not.toContain(answered.contextId);
  });
});

describe('A2A terminal task representation', () => {
  it('returns a completed task whose artifact carries the canonical body', async () => {
    const { context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });
    const result = task(response);

    // The task and context ids are access keys: random UUIDs, never the
    // predictable `IdGenerator` sequence this context uses
    expect(result.id).toMatch(UUID);
    expect(result.contextId).toMatch(UUID);
    expect(result.contextId).not.toBe(result.id);
    expect(result.status).toEqual({
      state: 'TASK_STATE_COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.artifactId).toMatch(/^a2a-artifact-/);
    expect(result.artifacts[0]?.name).toBe('market_report');
    expect(artifactData(response)).toEqual({ price: 42 });
  });

  it('attaches the delivery summary under the same meta key MCP uses', async () => {
    const { context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });
    const summary = task(response).artifacts[0]?.metadata?.[DELIVERY_SUMMARY_META_KEY];

    expect(summary).toMatchObject({ resourceId: 'market_report' });
  });

  it.each([
    ['a string body', 'plain text', { value: 'plain text' }],
    ['an array body', [1, 2], { value: [1, 2] }],
    ['a null body', null, { value: null }],
  ])('wraps %s so the data part is always an object', async (_label, body, expected) => {
    const { context } = setup({ ...(delivered as DeliveredOutcome), body });
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: {} });
    expect(artifactData(response)).toEqual(expected);
  });

  it('sanitizes an unexpected exception: nothing internal reaches the artifact', async () => {
    const boom = new Error('connect ECONNREFUSED 10.0.0.5:5432 while reading /etc/secret.key');
    const { context } = setup(boom);
    const adapter = createA2aAdapter();
    await adapter.start(context);

    const response = await send(adapter, { resource: 'market_report', input: { symbol: 'ETH' } });
    const serialized = JSON.stringify(response);

    expect(task(response).status.state).toBe('TASK_STATE_FAILED');
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('10.0.0.5');
    expect(serialized).not.toContain('/etc/secret.key');
    expect(artifactData(response)['code']).toBe('INTERNAL_ERROR');
  });
});

describe('A2A request limits and lifecycle', () => {
  it('refuses a body over the adapter cap without executing it', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);
    const padded = (bytes: number) =>
      sendMessagePayload({ resource: 'market_report', input: { symbol: 'x'.repeat(bytes) } });

    // 413 and -32600, as the gateway mount answers in front of the adapter
    const { status, body } = await post(adapter, padded(256 * 1024));
    expect(status).toBe(413);
    expect(body.error).toMatchObject({
      code: -32600,
      message: expect.stringContaining('byte limit'),
    });
    expect(execute).not.toHaveBeenCalled();

    // The same call under the cap executes
    await post(adapter, padded(200 * 1024));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('answers 503 once stopped and executes nothing', async () => {
    const { execute, context } = setup();
    const adapter = createA2aAdapter();
    await adapter.start(context);
    await adapter.stop();

    const { status, body } = await post(
      adapter,
      sendMessagePayload({ resource: 'market_report', input: { symbol: 'ETH' } }),
    );

    expect(status).toBe(503);
    expect(body.error?.code).toBe(-32603);
    expect(execute).not.toHaveBeenCalled();
  });
});
