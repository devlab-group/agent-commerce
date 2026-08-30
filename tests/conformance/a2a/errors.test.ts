/**
 * Protocol-level refusals, driven over raw HTTP: a conformant SDK client
 * cannot be made to send most of these, and using an SDK server helper to
 * generate the expected answers would test the SDK against itself.
 *
 * The rule under test is the split — a malformed or unsupported A2A request is
 * a JSON-RPC error; a commerce outcome never is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningGateway, startConformanceGateway } from './support/gateway.js';

let running: RunningGateway;

beforeAll(async () => {
  running = await startConformanceGateway();
});

afterAll(async () => {
  await running?.close();
});

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

async function post(body: unknown): Promise<{ status: number; body: JsonRpcResponse }> {
  const response = await fetch(`${running.url}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as JsonRpcResponse };
}

function sendMessage(params: unknown, id: string | number = 'e-1'): unknown {
  return { jsonrpc: '2.0', id, method: 'SendMessage', params };
}

function message(parts: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { message: { role: 'ROLE_USER', messageId: 'msg-1', parts, ...overrides } };
}

describe('JSON-RPC framing errors', () => {
  it.each([
    ['malformed JSON', '{"jsonrpc": "2.0", "id"', -32700],
    ['a jsonrpc version other than 2.0', { jsonrpc: '1.0', id: 1, method: 'SendMessage' }, -32600],
    ['a missing method', { jsonrpc: '2.0', id: 1 }, -32600],
    ['a non-object request', '"SendMessage"', -32600],
    ['invalid params', { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: 'nope' }, -32602],
  ])('answers %s with %i', async (_label, payload, code) => {
    const { status, body } = await post(payload);

    expect(status).toBe(200);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(code);
    expect(body.result).toBeUndefined();
  });
});

describe('method routing', () => {
  it('does not implement the legacy message/send name', async () => {
    const { body } = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: message([{ data: { resource: 'weather_basic', input: { city: 'Berlin' } } }]),
    });
    expect(body.error?.code).toBe(-32601);
  });

  it.each(['GetTask', 'ListTasks', 'CancelTask', 'SendStreamingMessage', 'SubscribeToTask'])(
    'refuses the known operation %s as unsupported, not unknown',
    async (method) => {
      const { body } = await post({ jsonrpc: '2.0', id: 1, method, params: {} });
      expect(body.error?.code).toBe(-32004);
      expect(body.error?.message).toContain(method);
    },
  );

  it('reports a method that does not exist as method-not-found', async () => {
    const { body } = await post({ jsonrpc: '2.0', id: 1, method: 'Frobnicate', params: {} });
    expect(body.error?.code).toBe(-32601);
  });
});

describe('invocation envelope refusals', () => {
  it('refuses an unsupported role', async () => {
    const { body } = await post(
      sendMessage(message([{ data: { resource: 'weather_basic' } }], { role: 'ROLE_AGENT' })),
    );
    expect(body.error?.code).toBe(-32602);
  });

  it.each([
    ['a text part', { text: 'what is the weather' }],
    ['an inline-bytes part', { raw: 'QUFBQQ==', filename: 'a.bin' }],
    ['a url part', { url: 'https://example.com/a.pdf' }],
    ['a v0.3 file part', { file: { uri: 'https://example.com/a.pdf' } }],
  ])('refuses %s as an unsupported part representation', async (_label, part) => {
    const { body } = await post(sendMessage(message([part])));
    expect(body.error?.code).toBe(-32004);
  });

  it('refuses multiple parts rather than choosing one', async () => {
    const { body } = await post(
      sendMessage(
        message([
          { data: { resource: 'weather_basic', input: { city: 'Berlin' } } },
          { data: { resource: 'http_only', input: {} } },
        ]),
      ),
    );
    expect(body.error?.code).toBe(-32004);
  });

  it('refuses task continuation, which it cannot honour', async () => {
    const { body } = await post(
      sendMessage(message([{ data: { resource: 'weather_basic' } }], { taskId: 'task-1' })),
    );
    expect(body.error?.code).toBe(-32004);
  });
});

describe('commerce outcomes are never JSON-RPC errors', () => {
  it('answers an unknown canonical resource with a failed task', async () => {
    const { body } = await post(
      sendMessage(message([{ data: { resource: 'no_such_resource', input: {} } }])),
    );

    expect(body.error).toBeUndefined();
    const task = (body.result as { task: { status: { state: string }; artifacts: unknown[] } })
      .task;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
  });
});

describe('redaction', () => {
  it('never returns a stack, a path, an internal hostname or an exception name', async () => {
    const responses = await Promise.all([
      post('{"jsonrpc":'),
      post({ jsonrpc: '2.0', id: 1, method: 'GetTask' }),
      post(sendMessage(message([{ data: { resource: 42 } }]))),
      post(sendMessage(message([{ data: { resource: 'weather_basic', input: { city: 42 } } }]))),
      post(sendMessage({ message: { role: 'ROLE_USER', parts: [] } })),
    ]);

    for (const { body } of responses) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/\bat .*:\d+:\d+/);
      expect(text).not.toMatch(/[/\\](src|node_modules)[/\\]/);
      expect(text).not.toMatch(/ZodError|TypeError|ECONNREFUSED|SQLITE/);
      expect(text).not.toContain('backend.local');
    }
  });
});
