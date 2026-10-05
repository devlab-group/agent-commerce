/**
 * Protocol-level refusals, driven over raw HTTP: a conformant SDK client
 * cannot be made to send most of these, and using an SDK server helper to
 * generate the expected answers would test the SDK against itself.
 *
 * The rule under test: a malformed or unsupported A2A request is a JSON-RPC
 * error, and a commerce outcome never is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningGateway, startConformanceGateway } from './support/gateway';

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
  readonly error?: { code: number; message: string; data?: Record<string, unknown>[] };
}

// Expected ErrorInfo detail for A2A-specific errors
function errorInfo(reason: string): Record<string, unknown>[] {
  return [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' },
  ];
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
    ['malformed JSON', -32700, '{"jsonrpc": "2.0", "id"'],
    ['a jsonrpc version other than 2.0', -32600, { jsonrpc: '1.0', id: 1, method: 'SendMessage' }],
    ['a missing method', -32600, { jsonrpc: '2.0', id: 1 }],
    ['a non-object request', -32600, '"SendMessage"'],
    ['invalid params', -32602, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: 'nope' }],
  ])('answers %s with %i', async (_label, code, payload) => {
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

  it.each(['ListTasks', 'SendStreamingMessage', 'SubscribeToTask', 'GetExtendedAgentCard'])(
    'returns UnsupportedOperationError for known method %s',
    async (method) => {
      const { body } = await post({ jsonrpc: '2.0', id: 1, method, params: {} });
      expect(body.error?.code).toBe(-32004);
      expect(body.error?.message).toContain(method);
      expect(body.error?.data).toEqual(errorInfo('UNSUPPORTED_OPERATION'));
    },
  );

  // A2A has no capability flag for declining these two
  it.each(['GetTask', 'CancelTask'])('returns TaskNotFoundError for %s', async (method) => {
    const { body } = await post({ jsonrpc: '2.0', id: 1, method, params: { id: 'task-1' } });
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toContain('not retained');
    expect(body.error?.data).toEqual(errorInfo('TASK_NOT_FOUND'));
  });

  // Push configuration methods return -32003 when the card disables them
  it.each([
    'CreateTaskPushNotificationConfig',
    'GetTaskPushNotificationConfig',
    'ListTaskPushNotificationConfigs',
    'DeleteTaskPushNotificationConfig',
  ])('refuses %s with PushNotificationNotSupportedError', async (method) => {
    const { body } = await post({ jsonrpc: '2.0', id: 1, method, params: {} });
    expect(body.error?.code).toBe(-32003);
    expect(body.error?.data).toEqual(errorInfo('PUSH_NOTIFICATION_NOT_SUPPORTED'));
  });

  it('returns method-not-found without A2A detail for an unknown method', async () => {
    const { body } = await post({ jsonrpc: '2.0', id: 1, method: 'Frobnicate', params: {} });
    expect(body.error?.code).toBe(-32601);
    expect(body.error).not.toHaveProperty('data');
  });

  it('echoes a string or number id and answers any other id with null', async () => {
    const echoed = async (id: unknown) =>
      (await post({ jsonrpc: '2.0', id, method: 'Frobnicate', params: {} })).body.id;

    expect(await echoed('call-7')).toBe('call-7');
    expect(await echoed(7)).toBe(7);
    expect(await echoed({ injected: true })).toBeNull();
    expect(await echoed(['call-7'])).toBeNull();
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
  ])('refuses %s with ContentTypeNotSupportedError', async (_label, part) => {
    const { body } = await post(sendMessage(message([part])));
    expect(body.error?.code).toBe(-32005);
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

  it('returns TaskNotFoundError for an unknown task id', async () => {
    const { body } = await post(
      sendMessage(message([{ data: { resource: 'weather_basic' } }], { taskId: 'task-1' })),
    );
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.data).toEqual(errorInfo('TASK_NOT_FOUND'));
  });

  it('returns ContentTypeNotSupportedError for a non-JSON data part', async () => {
    const { body } = await post(
      sendMessage(message([{ data: { resource: 'weather_basic' }, mediaType: 'text/csv' }])),
    );
    expect(body.error?.code).toBe(-32005);
    expect(body.error?.data).toEqual(errorInfo('CONTENT_TYPE_NOT_SUPPORTED'));
  });

  it('refuses a request without an id and runs nothing', async () => {
    const { body } = await post({
      jsonrpc: '2.0',
      method: 'SendMessage',
      params: message([{ data: { resource: 'weather_basic', input: { city: 'Berlin' } } }]),
    });
    expect(body.error?.code).toBe(-32600);
    expect(body.id).toBeNull();
    expect(body.result).toBeUndefined();
  });

  it('returns invalid params when messageId is missing', async () => {
    const { body } = await post(
      sendMessage(message([{ data: { resource: 'weather_basic' } }], { messageId: undefined })),
    );
    expect(body.error?.code).toBe(-32602);
  });
});

describe('commerce outcomes are never JSON-RPC errors', () => {
  it('answers an unknown canonical resource with a failed task', async () => {
    const { body } = await post(
      sendMessage(message([{ data: { resource: 'no_such_resource', input: {} } }])),
    );

    expect(body.error).toBeUndefined();
    const task = (
      body.result as {
        task: { id: string; contextId: string; status: Record<string, unknown> };
      }
    ).task;
    expect(task.status['state']).toBe('TASK_STATE_FAILED');
    // The reason a generic client shows, without reading the artifact
    expect(task.status['message']).toMatchObject({
      role: 'ROLE_AGENT',
      taskId: task.id,
      contextId: task.contextId,
      parts: [{ text: 'Unknown canonical resource "no_such_resource".' }],
    });
    expect(task.status['message']).not.toHaveProperty('extensions');
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
