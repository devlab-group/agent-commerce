/**
 * Check parameter refusals over raw HTTP and verify that they make no backend
 * calls or task-store reads. The `SendMessage` cases include a task ID, which
 * would trigger a lookup if parameter validation ran too late.
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
  readonly result?: { task?: { status?: { state?: string } } };
  readonly error?: { code: number; message: string };
}

async function post(method: string, params: unknown): Promise<JsonRpcResponse> {
  const response = await fetch(`${running.url}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'p-1', method, params }),
  });
  return (await response.json()) as JsonRpcResponse;
}

// Check the refusal code and confirm that backend and task-read counts stay unchanged
async function expectRefused(method: string, params: unknown, code: number): Promise<string> {
  const backendBefore = running.backendCalls();
  const readsBefore = running.taskReads();
  const body = await post(method, params);
  expect(body.error?.code, JSON.stringify(body)).toBe(code);
  expect(running.backendCalls()).toBe(backendBefore);
  expect(running.taskReads()).toBe(readsBefore);
  return body.error?.message ?? '';
}

const PART = { data: { resource: 'weather_basic', input: { city: 'Berlin' } } };
const MESSAGE = { role: 'ROLE_USER', messageId: 'msg-1', parts: [PART] };
// Include a task ID so a request that passes parameter checks would trigger a lookup
const ON_TASK = { ...MESSAGE, taskId: 'task-1' };

describe('SendMessage parameters', () => {
  it.each([
    ['a non-empty tenant', { tenant: 'acme' }, -32004],
    ['a tenant that is not a string', { tenant: 7 }, -32602],
    ['a configuration that is not an object', { configuration: [] }, -32602],
    [
      'output modes without JSON',
      { configuration: { acceptedOutputModes: ['text/plain'] } },
      -32005,
    ],
    [
      'output modes that are not a list',
      { configuration: { acceptedOutputModes: 'application/json' } },
      -32602,
    ],
    [
      'a push notification config',
      { configuration: { taskPushNotificationConfig: { url: 'https://hooks.example' } } },
      -32003,
    ],
    ['a negative historyLength', { configuration: { historyLength: -1 } }, -32602],
    ['a fractional historyLength', { configuration: { historyLength: 1.5 } }, -32602],
    [
      'a returnImmediately that is not a boolean',
      { configuration: { returnImmediately: 'yes' } },
      -32602,
    ],
    ['metadata that is not an object', { metadata: 'note' }, -32602],
  ])('refuses %s', async (_label, fields, code) => {
    await expectRefused('SendMessage', { message: ON_TASK, ...fields }, code);
  });

  it('runs a request whose optional parameters all hold accepted values', async () => {
    const before = running.backendCalls();
    const body = await post('SendMessage', {
      tenant: '',
      message: MESSAGE,
      configuration: {
        acceptedOutputModes: ['text/plain', 'application/*'],
        historyLength: '3',
        returnImmediately: false,
        taskPushNotificationConfig: null,
      },
      metadata: {},
    });
    expect(body.result?.task?.status?.state).toBe('TASK_STATE_COMPLETED');
    expect(running.backendCalls()).toBe(before + 1);
  });
});

describe('task operation parameters', () => {
  it.each([
    ['GetTask', 'a non-empty tenant', { id: 'task-1', tenant: 'acme' }, -32004],
    ['GetTask', 'no id', {}, -32602],
    ['GetTask', 'an empty id', { id: '' }, -32602],
    ['GetTask', 'an id that is not a string', { id: 7 }, -32602],
    ['GetTask', 'a negative historyLength', { id: 'task-1', historyLength: -1 }, -32602],
    ['CancelTask', 'a non-empty tenant', { id: 'task-1', tenant: 'acme' }, -32004],
    ['CancelTask', 'no id', {}, -32602],
    ['CancelTask', 'metadata that is not an object', { id: 'task-1', metadata: [] }, -32602],
    ['ListTasks', 'a non-empty tenant', { tenant: 'acme' }, -32004],
    ['ListTasks', 'a contextId that is not a string', { contextId: 5 }, -32602],
    ['ListTasks', 'an unknown status', { status: 'TASK_STATE_DONE' }, -32602],
    ['ListTasks', 'a pageSize of 0', { pageSize: 0 }, -32602],
    ['ListTasks', 'a pageSize of 101', { pageSize: 101 }, -32602],
    ['ListTasks', 'a pageToken it never issued', { pageToken: 'not-a-token' }, -32602],
    [
      'ListTasks',
      'a statusTimestampAfter with an offset',
      { statusTimestampAfter: '2026-01-01T01:00:00+01:00' },
      -32602,
    ],
    [
      'ListTasks',
      'an includeArtifacts that is not a boolean',
      { includeArtifacts: 'true' },
      -32602,
    ],
    ['ListTasks', 'a negative historyLength', { historyLength: -1 }, -32602],
  ])('%s refuses %s', async (method, _label, params, code) => {
    await expectRefused(method, params, code);
  });
});

describe('proto field names', () => {
  it('runs a request sent with proto field names', async () => {
    const before = running.backendCalls();
    const body = await post('SendMessage', {
      message: {
        role: 'ROLE_USER',
        message_id: 'msg-proto',
        parts: [{ ...PART, media_type: 'application/json' }],
      },
      configuration: { accepted_output_modes: ['application/json'], history_length: 0 },
    });
    expect(body.result?.task?.status?.state).toBe('TASK_STATE_COMPLETED');
    expect(running.backendCalls()).toBe(before + 1);
  });

  it('checks a parameter sent under its proto name', async () => {
    await expectRefused(
      'SendMessage',
      { message: ON_TASK, configuration: { accepted_output_modes: ['text/plain'] } },
      -32005,
    );
    await expectRefused('ListTasks', { page_size: 0 }, -32602);
  });

  it('refuses context_id as it refuses contextId, in the message and in the params', async () => {
    const camel = await expectRefused(
      'SendMessage',
      { message: { ...MESSAGE, contextId: 'ctx-1' } },
      -32004,
    );
    expect(
      await expectRefused('SendMessage', { message: { ...MESSAGE, context_id: 'ctx-1' } }, -32004),
    ).toBe(camel);
    expect(
      await expectRefused('SendMessage', { message: MESSAGE, context_id: 'ctx-1' }, -32004),
    ).toBe(camel);
  });

  it('answers an unknown task_id as it answers an unknown taskId', async () => {
    const answer = async (message: Record<string, unknown>) =>
      (await post('SendMessage', { message })).error;
    expect(await answer({ ...MESSAGE, task_id: 'task-1' })).toEqual(
      await answer({ ...MESSAGE, taskId: 'task-1' }),
    );
    expect((await answer({ ...MESSAGE, task_id: 'task-1' }))?.code).toBe(-32001);
  });

  it.each([
    ['SendMessage', 'the message', { message: { ...ON_TASK, message_id: 'msg-2' } }, 'messageId'],
    [
      'SendMessage',
      'a message part',
      { message: { ...ON_TASK, parts: [{ ...PART, mediaType: 'a', media_type: 'b' }] } },
      'mediaType',
    ],
    ['ListTasks', 'the params', { pageSize: 10, page_size: 20 }, 'pageSize'],
    [
      'GetTask',
      'the params',
      { id: 'task-1', history_length: 1, historyLength: 2 },
      'historyLength',
    ],
  ])('%s refuses a field that %s sends under both names', async (method, _where, params, field) => {
    const message = await expectRefused(method, params, -32602);
    const proto = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    expect(message).toContain(`"${field}"`);
    expect(message).toContain(`"${proto}"`);
  });
});
