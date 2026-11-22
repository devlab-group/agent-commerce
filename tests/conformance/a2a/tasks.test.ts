/**
 * Exercise `GetTask`, `ListTasks` and `CancelTask` through raw HTTP and the
 * official SDK, using a listening gateway and an in-memory SQLite receipt
 * store. The HTTP helper checks successful results against the vendored TCK
 * response schema. Tasks waiting for an x402 extension payment are covered in
 * `tests/integration/a2a-x402-extension.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { TaskState } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskRecord } from '../../../src/core';
import type { A2aTask } from '../../../src/protocols/a2a/types';
import { MERCHANT_BODY, type RunningGateway, startConformanceGateway } from './support/gateway';
import { type TckDefinition, tckErrors } from './support/task-schema';

let running: RunningGateway;

beforeAll(async () => {
  running = await startConformanceGateway();
});

afterAll(async () => {
  await running?.close();
});

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

interface TaskPage {
  readonly tasks: Partial<A2aTask>[];
  readonly nextPageToken: string;
  readonly pageSize: number;
  readonly totalSize: number;
}

// Schema definition for each method's result
const RESULT_SCHEMA: Record<string, TckDefinition> = {
  SendMessage: 'Send Message Response',
  GetTask: 'Task',
  CancelTask: 'Task',
  ListTasks: 'List Tasks Response',
};

async function post(method: string, params: unknown): Promise<JsonRpcResponse> {
  const response = await fetch(`${running.url}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 't-1', method, params }),
  });
  const body = (await response.json()) as JsonRpcResponse;
  const schema = RESULT_SCHEMA[method];
  if (body.result !== undefined && schema !== undefined) {
    expect(tckErrors(schema, body.result), `${method} result against the TCK schema`).toEqual([]);
  }
  return body;
}

function invocation(data: unknown, overrides: Record<string, unknown> = {}) {
  return {
    message: {
      role: 'ROLE_USER',
      messageId: randomUUID(),
      parts: [{ data, mediaType: 'application/json' }],
      ...overrides,
    },
  };
}

async function send(data: unknown): Promise<A2aTask> {
  const body = await post('SendMessage', invocation(data));
  return (body.result as { task: A2aTask }).task;
}

const free = () => send({ resource: 'weather_basic', input: { city: 'Berlin' } });

function withoutArtifacts(task: A2aTask): Partial<A2aTask> {
  const { artifacts: _artifacts, ...rest } = task;
  return rest;
}

const HOUR_10 = '2026-11-22T10:00:00.000Z';
const HOUR_11 = '2026-11-22T11:00:00.000Z';
const FAR = '2999-01-01T00:00:00.000Z';

// A task written to the store as the adapter writes one
async function recorded(
  contextId: string,
  id: string,
  state: string,
  timestamp: string,
  overrides: Partial<TaskRecord> = {},
): Promise<A2aTask> {
  const task: A2aTask = { id, contextId, status: { state, timestamp }, artifacts: [] };
  await running.store.putTaskRecord?.(
    {
      id,
      protocol: 'a2a',
      groupId: contextId,
      state,
      updatedAt: timestamp,
      document: task as unknown as Record<string, unknown>,
      expiresAt: FAR,
      ...overrides,
    },
    { maxRecords: 1000 },
  );
  return task;
}

describe('GetTask', () => {
  it('returns a completed task as SendMessage answered it', async () => {
    const task = await free();

    const { result } = await post('GetTask', { id: task.id });

    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(result).toEqual(task);
  });

  it.each([
    ['a paid resource asked for without a proof', 'market_report'],
    ['an unknown resource', 'no_such_resource'],
  ])('returns a failed task: %s', async (_label, resource) => {
    const task = await send({ resource, input: { symbol: 'ETH' } });

    const { result } = await post('GetTask', { id: task.id });

    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(result).toEqual(task);
  });

  it('reads the task through the SDK client', async () => {
    const task = await free();
    const client = await new ClientFactory().createFromUrl(running.url);

    const read = await client.getTask({ tenant: '', id: task.id });

    expect(read.id).toBe(task.id);
    expect(read.contextId).toBe(task.contextId);
    expect(read.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(read.artifacts[0]?.parts[0]?.content?.value).toEqual(MERCHANT_BODY);
  });

  it('reports a working task that no process is running as failed, and leaves the record', async () => {
    const contextId = randomUUID();
    const id = randomUUID();
    await recorded(contextId, id, 'TASK_STATE_WORKING', HOUR_10);

    const { result } = await post('GetTask', { id });

    const task = result as A2aTask;
    expect(task).toMatchObject({
      id,
      contextId,
      status: { state: 'TASK_STATE_FAILED', timestamp: HOUR_10 },
    });
    const reason =
      'This task stopped before its result was recorded. Any payment is in the gateway records: check with the merchant before paying again.';
    expect(task.status.message?.parts).toEqual([{ text: reason }]);
    expect(task.artifacts[0]?.parts[0]?.data).toEqual({
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: reason,
      retryable: false,
    });
    expect((await running.store.getTaskRecord?.(id))?.state).toBe('TASK_STATE_WORKING');
  });

  it("answers another protocol's task as it answers an unknown id", async () => {
    const id = randomUUID();
    await recorded(randomUUID(), id, 'TASK_STATE_COMPLETED', HOUR_10, { protocol: 'acp' });

    const other = await post('GetTask', { id });
    const unknown = await post('GetTask', { id: randomUUID() });

    expect(other.error?.code).toBe(-32001);
    expect(other).toEqual(unknown);
  });
});

describe('ListTasks', () => {
  it.each([
    ['no context', {}],
    ['an empty context', { contextId: '' }],
    ['an unknown context', { contextId: randomUUID() }],
  ])('lists nothing for %s, with all four fields', async (_label, params) => {
    await free();

    const { result } = await post('ListTasks', params);

    expect(result).toEqual({ tasks: [], nextPageToken: '', pageSize: 50, totalSize: 0 });
  });

  it("lists the context's task without its artifacts unless asked", async () => {
    const task = await free();

    const plain = await post('ListTasks', { contextId: task.contextId });
    const full = await post('ListTasks', { contextId: task.contextId, includeArtifacts: true });

    expect(plain.result).toEqual({
      tasks: [withoutArtifacts(task)],
      nextPageToken: '',
      pageSize: 50,
      totalSize: 1,
    });
    expect((full.result as TaskPage).tasks).toEqual([task]);
  });

  it('pages newest first, a tie by id, with a cursor to the next page', async () => {
    const contextId = randomUUID();
    const a = await recorded(contextId, 'task-a', 'TASK_STATE_COMPLETED', HOUR_10);
    const b = await recorded(contextId, 'task-b', 'TASK_STATE_FAILED', HOUR_11);
    const c = await recorded(contextId, 'task-c', 'TASK_STATE_COMPLETED', HOUR_11);

    const first = (await post('ListTasks', { contextId, pageSize: 2 })).result as TaskPage;
    const second = (
      await post('ListTasks', { contextId, pageSize: 2, pageToken: first.nextPageToken })
    ).result as TaskPage;

    expect(first).toMatchObject({ pageSize: 2, totalSize: 3 });
    expect(first.tasks).toEqual([withoutArtifacts(c), withoutArtifacts(b)]);
    expect(first.nextPageToken).not.toBe('');
    expect(second).toEqual({
      tasks: [withoutArtifacts(a)],
      nextPageToken: '',
      pageSize: 2,
      totalSize: 3,
    });
  });

  it('filters by state, and by status timestamp inclusively', async () => {
    const contextId = randomUUID();
    await recorded(contextId, 'task-a', 'TASK_STATE_COMPLETED', HOUR_10);
    await recorded(contextId, 'task-b', 'TASK_STATE_FAILED', HOUR_11);
    await recorded(contextId, 'task-c', 'TASK_STATE_COMPLETED', HOUR_11);
    const ids = async (filter: Record<string, unknown>) => {
      const page = (await post('ListTasks', { contextId, ...filter })).result as TaskPage;
      return { ids: page.tasks.map((task) => task.id), totalSize: page.totalSize };
    };

    expect(await ids({ status: 'TASK_STATE_COMPLETED' })).toEqual({
      ids: ['task-c', 'task-a'],
      totalSize: 2,
    });
    expect(await ids({ statusTimestampAfter: HOUR_11 })).toEqual({
      ids: ['task-c', 'task-b'],
      totalSize: 2,
    });
    expect(await ids({ status: 'TASK_STATE_UNSPECIFIED' })).toEqual({
      ids: ['task-c', 'task-b', 'task-a'],
      totalSize: 3,
    });
  });

  it('filters a stale working task by the state it is reported in', async () => {
    const contextId = randomUUID();
    await recorded(contextId, 'task-w', 'TASK_STATE_WORKING', HOUR_10);

    const working = (await post('ListTasks', { contextId, status: 'TASK_STATE_WORKING' }))
      .result as TaskPage;
    const failed = (await post('ListTasks', { contextId, status: 'TASK_STATE_FAILED' }))
      .result as TaskPage;

    expect(working.tasks).toEqual([]);
    expect(failed.tasks.map((task) => [task.id, task.status?.state])).toEqual([
      ['task-w', 'TASK_STATE_FAILED'],
    ]);
  });

  it('lists through the SDK client, which sends every field', async () => {
    const task = await free();
    const client = await new ClientFactory().createFromUrl(running.url);

    const page = await client.listTasks({
      tenant: '',
      contextId: task.contextId,
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
    });

    expect(page.tasks.map((listed) => listed.id)).toEqual([task.id]);
    expect(page).toMatchObject({ nextPageToken: '', pageSize: 50, totalSize: 1 });
  });
});

describe('CancelTask', () => {
  it.each([
    ['completed', () => free()],
    ['failed', () => send({ resource: 'market_report', input: { symbol: 'ETH' } })],
  ])('refuses a %s task, which stays as it was', async (_label, make) => {
    const task = await make();

    const { error } = await post('CancelTask', { id: task.id });

    expect(error?.code).toBe(-32002);
    expect((await post('GetTask', { id: task.id })).result).toEqual(task);
  });

  it('returns a canceled task unchanged through the SDK client', async () => {
    const contextId = randomUUID();
    const canceled = await recorded(contextId, randomUUID(), 'TASK_STATE_CANCELED', HOUR_10);
    const client = await new ClientFactory().createFromUrl(running.url);

    const again = await client.cancelTask({ tenant: '', id: canceled.id, metadata: undefined });

    expect(again.id).toBe(canceled.id);
    expect(again.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect((await post('GetTask', { id: canceled.id })).result).toEqual(canceled);
  });
});

describe('SendMessage naming a recorded task', () => {
  it('refuses a message on a finished task and runs nothing', async () => {
    const task = await free();
    const calls = running.backendCalls();

    const inferred = await post('SendMessage', invocation({}, { taskId: task.id }));
    const matching = await post(
      'SendMessage',
      invocation({}, { taskId: task.id, contextId: task.contextId }),
    );

    expect(inferred.error?.code).toBe(-32004);
    expect(matching.error?.code).toBe(-32004);
    expect(running.backendCalls()).toBe(calls);
  });

  it('refuses a context that does not match the task', async () => {
    const task = await free();

    const { error } = await post(
      'SendMessage',
      invocation({}, { taskId: task.id, contextId: randomUUID() }),
    );

    expect(error?.code).toBe(-32602);
  });
});

describe('task and context ids', () => {
  it('gives every task its own random ids, apart from the request id', async () => {
    const [one, two] = await Promise.all([free(), free()]);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    for (const task of [one, two]) {
      expect(task?.id).toMatch(uuid);
      expect(task?.contextId).toMatch(uuid);
    }
    expect(new Set([one?.id, one?.contextId, two?.id, two?.contextId]).size).toBe(4);
    const summary = one?.artifacts[0]?.metadata?.['agent-commerce/delivery'] as
      | { requestId?: string }
      | undefined;
    expect(summary?.requestId).toMatch(/^a2a/);
    expect(summary?.requestId).not.toBe(one?.id);
  });

  it("lists nothing from another task's context", async () => {
    const mine = await free();
    await free();

    const page = (await post('ListTasks', { contextId: mine.contextId })).result as TaskPage;

    expect(page.tasks.map((task) => task.id)).toEqual([mine.id]);
  });
});
