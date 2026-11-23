/**
 * Retain task responses for `GetTask`, `ListTasks` and `CancelTask` until expiry.
 *
 * Use the receipt store's complete task-record group, or process memory under
 * the same capacity and expiry rules. A durable store can preserve records
 * across restarts; process memory cannot. At capacity, evict eligible
 * uncharged responses to admit new records, or refuse a new record if too few
 * can be evicted. Existing IDs can still be replaced. Response records are
 * separate from the pending state that permits payment.
 */
import type { Clock } from '../../core';
import type { StoreGroupMethods } from '../../core/store-method-groups';
import type { A2aTask } from './types';

export interface A2aTaskStore {
  /**
   * Store the task with `expiresAt`, replacing an existing ID even at capacity.
   * Mark uncharged responses `evictable` to allow early eviction. Return false
   * if too few records are evictable to admit a new ID.
   */
  put(task: A2aTask, expiresAt: string, evictable?: boolean): Promise<boolean>;
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
    put: (task, expiresAt, evictable) =>
      store.putTaskRecord(
        {
          id: task.id,
          protocol: 'a2a',
          groupId: task.contextId,
          state: task.status.state,
          updatedAt: task.status.timestamp,
          document: task as unknown as Readonly<Record<string, unknown>>,
          expiresAt,
          ...(evictable === true ? { evictable } : {}),
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
  // Map order is write order: a replacement is deleted and set again
  const tasks = new Map<
    string,
    { readonly task: A2aTask; readonly expiresAtMs: number; readonly evictable: boolean }
  >();
  const live = (expiresAtMs: number): boolean => expiresAtMs > clock.now().getTime();

  return {
    async put(task, expiresAt, evictable = false) {
      // Sweep expired records, then the earliest written evictable one, when
      // capacity would block a new id
      if (!tasks.has(task.id) && tasks.size >= maxRecords) {
        for (const [id, held] of tasks) if (!live(held.expiresAtMs)) tasks.delete(id);
        if (tasks.size >= maxRecords) {
          let oldest: string | undefined;
          for (const [id, held] of tasks) {
            if (held.evictable) {
              oldest = id;
              break;
            }
          }
          if (oldest === undefined) return false;
          tasks.delete(oldest);
        }
      }
      tasks.delete(task.id);
      tasks.set(task.id, { task, expiresAtMs: Date.parse(expiresAt), evictable });
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
