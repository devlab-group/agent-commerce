/**
 * Serve `GetTask`, `ListTasks` and `CancelTask` from retained task responses
 * and pending-payment state, without verification, settlement or backend calls.
 *
 * The adapter has no A2A authentication. Random task and context ids act as
 * access keys: task ids permit reads and cancellation requests; listing is
 * limited to the named context. Unknown ids and another protocol's records
 * both return task-not-found. Listing without a context returns no tasks.
 */
import { type Clock, CommerceError } from '../../core';
import { A2A_TASK_STATE_CANCELED, A2A_TASK_STATE_WORKING } from './constants';
import {
  A2A_ERROR_TASK_NOT_CANCELABLE,
  A2A_ERROR_TASK_NOT_FOUND,
  type JsonRpcId,
  jsonRpcError,
  jsonRpcResult,
} from './jsonrpc';
import {
  type CancelTaskParams,
  encodePageToken,
  type GetTaskParams,
  type ListTasksParams,
} from './params';
import { canceledTask, interruptedTask } from './task-mapping';
import type { A2aTaskStore } from './task-store';
import type { A2aTask } from './types';
import type { PendingPayments } from './x402-extension';

export interface TaskOperations {
  readonly tasks: A2aTaskStore;
  readonly pendingPayments: PendingPayments;
  /** Active task ids, including blocking payments and background runs */
  readonly running: ReadonlySet<string>;
  readonly clock: Clock;
  /** Expiry to assign when recording a task now */
  readonly retainedUntil: () => string;
  readonly nextMessageId: () => string;
}

const NOT_FOUND = 'Task not found.';

// Report a stored working task as failed when it has no local running entry.
// ponytail: this assumes one gateway per store; shared stores need a lease.
function reported(task: A2aTask, running: ReadonlySet<string>): A2aTask {
  return task.status.state === A2A_TASK_STATE_WORKING && !running.has(task.id)
    ? interruptedTask(task)
    : task;
}

export async function getTask(
  ops: TaskOperations,
  id: JsonRpcId,
  params: GetTaskParams,
): Promise<Record<string, unknown>> {
  const task = await ops.tasks.get(params.id);
  if (task === undefined) return jsonRpcError(id, A2A_ERROR_TASK_NOT_FOUND, NOT_FOUND);
  // No history is retained, so historyLength has no effect
  return jsonRpcResult(id, reported(task, ops.running));
}

// Compare timestamps newest first, then ids descending, for both sorting and cursors
function before(a: { at: number; id: string }, b: { at: number; id: string }): boolean {
  return a.at > b.at || (a.at === b.at && a.id > b.id);
}

export async function listTasks(
  ops: TaskOperations,
  id: JsonRpcId,
  params: ListTasksParams,
): Promise<Record<string, unknown>> {
  // Require a context access key before reading its tasks
  const recorded = params.contextId === undefined ? [] : await ops.tasks.list(params.contextId);
  const after =
    params.statusTimestampAfter !== undefined ? Date.parse(params.statusTimestampAfter) : undefined;
  const matching = recorded
    .map((task) => reported(task, ops.running))
    .filter((task) => params.status === undefined || task.status.state === params.status)
    .filter((task) => after === undefined || Date.parse(task.status.timestamp) >= after)
    .map((task) => ({ task, key: { at: Date.parse(task.status.timestamp), id: task.id } }))
    .sort((a, b) => (before(a.key, b.key) ? -1 : before(b.key, a.key) ? 1 : 0));

  // Start at the first matching task after the cursor
  let start = 0;
  if (params.after !== undefined) {
    const key = { at: Date.parse(params.after.updatedAt), id: params.after.id };
    start = matching.findIndex((entry) => before(key, entry.key));
    if (start === -1) start = matching.length;
  }
  const page = matching.slice(start, start + params.pageSize);
  const last = page.at(-1);
  const more = start + page.length < matching.length;

  return jsonRpcResult(id, {
    tasks: page.map(({ task }) => {
      if (params.includeArtifacts) return task;
      const { artifacts: _artifacts, ...rest } = task;
      return rest;
    }),
    nextPageToken:
      more && last !== undefined
        ? encodePageToken({ updatedAt: last.task.status.timestamp, id: last.task.id })
        : '',
    pageSize: params.pageSize,
    totalSize: matching.length,
  });
}

/**
 * Use the same atomic take as payment messages, so only the call that takes
 * the pending purchase proceeds. Repeated cancellation returns the canceled
 * task unchanged (A2A 1.0.1 section 3.3.1).
 */
export async function cancelTask(
  ops: TaskOperations,
  id: JsonRpcId,
  params: CancelTaskParams,
): Promise<Record<string, unknown>> {
  const taken = await ops.pendingPayments.take(params.id);
  if (taken !== undefined) {
    const canceled = canceledTask(
      params.id,
      taken.contextId,
      ops.clock.nowIso(),
      ops.nextMessageId(),
    );
    // The pending purchase is already removed. If this write fails, the caller
    // gets an internal error and the old response keeps its original expiry.
    if (!(await ops.tasks.put(canceled, ops.retainedUntil()))) {
      throw new CommerceError('STORAGE_ERROR', 'The canceled task did not fit in the task store.');
    }
    return jsonRpcResult(id, canceled);
  }
  const task = await ops.tasks.get(params.id);
  if (task === undefined) return jsonRpcError(id, A2A_ERROR_TASK_NOT_FOUND, NOT_FOUND);
  if (task.status.state === A2A_TASK_STATE_CANCELED) return jsonRpcResult(id, task);
  return jsonRpcError(
    id,
    A2A_ERROR_TASK_NOT_CANCELABLE,
    'Only a task waiting for payment can be canceled; this one is running or finished.',
  );
}
