/**
 * Retain task responses for `GetTask`, `ListTasks` and `CancelTask` until expiry.
 *
 * Use the receipt store's complete task-record group, or process memory under
 * the same capacity and expiry rules. A durable store can preserve records
 * across restarts; process memory cannot. At capacity, refuse new records and
 * allow replacements without evicting unexpired paid results. These response
 * records are separate from the pending state that permits payment.
 */
import type { Clock } from '../../core';
import type { StoreGroupMethods } from '../../core/store-method-groups';
import type { A2aTask } from './types';

export interface A2aTaskStore {
  /**
   * Retain the task until `expiresAt`, replacing any record with the same id.
   * Return false without storing a new id when the store is full.
   */
  put(task: A2aTask, expiresAt: string): Promise<boolean>;
  get(id: string): Promise<A2aTask | undefined>;
  /** Unexpired tasks in the named context, with no ordering guarantee */
  list(contextId: string): Promise<readonly A2aTask[]>;
}

/** Store tasks as `TaskRecord`s, using the context id as `groupId` */
export function createStoredTasks(
  store: StoreGroupMethods<'task_records'>,
  maxRecords: number,
): A2aTaskStore {
  return {
    put: (task, expiresAt) =>
      store.putTaskRecord(
        {
          id: task.id,
          protocol: 'a2a',
          groupId: task.contextId,
          state: task.status.state,
          updatedAt: task.status.timestamp,
          document: task as unknown as Readonly<Record<string, unknown>>,
          expiresAt,
        },
        { maxRecords },
      ),
    async get(id) {
      const record = await store.getTaskRecord(id);
      // Treat another protocol's record as a missing task
      return record?.protocol === 'a2a' ? (record.document as unknown as A2aTask) : undefined;
    },
    async list(contextId) {
      const records = await store.listTaskRecords({ protocol: 'a2a', groupId: contextId });
      return records.map((record) => record.document as unknown as A2aTask);
    },
  };
}

/** Retain tasks in a map owned by this process */
export function createMemoryTasks(clock: Clock, maxRecords: number): A2aTaskStore {
  const tasks = new Map<string, { readonly task: A2aTask; readonly expiresAtMs: number }>();
  const live = (expiresAtMs: number): boolean => expiresAtMs > clock.now().getTime();

  return {
    async put(task, expiresAt) {
      // Sweep expired records when capacity would block a new id
      if (!tasks.has(task.id) && tasks.size >= maxRecords) {
        for (const [id, held] of tasks) if (!live(held.expiresAtMs)) tasks.delete(id);
        if (tasks.size >= maxRecords) return false;
      }
      tasks.set(task.id, { task, expiresAtMs: Date.parse(expiresAt) });
      return true;
    },
    async get(id) {
      const held = tasks.get(id);
      return held !== undefined && live(held.expiresAtMs) ? held.task : undefined;
    },
    // ponytail: listing scans all tasks; add a context index if large stores become slow
    async list(contextId) {
      return [...tasks.values()]
        .filter((held) => held.task.contextId === contextId && live(held.expiresAtMs))
        .map((held) => held.task);
    },
  };
}
