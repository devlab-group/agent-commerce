/**
 * Purchases waiting for a payment message. Remove the top-level `_payment`
 * and `_authorization` fields before storing input. The remaining input and
 * adapter data are unredacted; callers must keep payment proofs and
 * authorization presentations out of them.
 */
import type Database from 'better-sqlite3';
import {
  type Clock,
  CommerceError,
  type PendingTask,
  RESERVED_INPUT_FIELDS,
  toCommerceError,
} from '../../core';
import type { StoreGroupMethods } from '../../core/store-method-groups';
import { storedIso } from './params';

interface TaskRow {
  id: string;
  protocol: string;
  resource_id: string;
  input_json: string;
  adapter_data_json: string | null;
  expires_at: string;
}

type PendingTaskMethods = StoreGroupMethods<'pending_tasks'>;

function rowToTask(row: TaskRow): PendingTask {
  return {
    id: row.id,
    protocol: row.protocol as PendingTask['protocol'],
    resourceId: row.resource_id,
    input: JSON.parse(row.input_json),
    ...(row.adapter_data_json !== null ? { adapterData: JSON.parse(row.adapter_data_json) } : {}),
    expiresAt: row.expires_at,
  };
}

function withoutReservedFields(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !RESERVED_INPUT_FIELDS.includes(key)),
  );
}

const SWEEP_EXPIRED = 'DELETE FROM pending_tasks WHERE expires_at <= ?';

/** Deletes expired pending tasks, for `init()` of a writable store */
export function sweepExpiredPendingTasks(db: Database.Database, now: string): void {
  db.prepare(SWEEP_EXPIRED).run(now);
}

export function createPendingTaskMethods(db: Database.Database, clock: Clock): PendingTaskMethods {
  const sweepExpired = db.prepare(SWEEP_EXPIRED);
  const countLive = db.prepare<[string], { count: number }>(
    'SELECT COUNT(*) AS count FROM pending_tasks WHERE expires_at > ?',
  );
  const upsertTask = db.prepare(
    `INSERT OR REPLACE INTO pending_tasks
       (id, protocol, resource_id, input_json, adapter_data_json, created_at, expires_at)
     VALUES (@id, @protocol, @resource_id, @input_json, @adapter_data_json, @created_at, @expires_at)`,
  );
  const selectLive = db.prepare<[string, string], TaskRow>(
    'SELECT * FROM pending_tasks WHERE id = ? AND expires_at > ?',
  );
  // Delete and return in one statement so only one caller can take the task
  const takeLive = db.prepare<[string, string], TaskRow>(
    'DELETE FROM pending_tasks WHERE id = ? AND expires_at > ? RETURNING *',
  );

  const put = db.transaction((task: PendingTask, maxTasks: number, expiresAt: string): boolean => {
    const now = clock.nowIso();
    sweepExpired.run(now);
    if ((countLive.get(now)?.count ?? 0) >= maxTasks) return false;
    upsertTask.run({
      id: task.id,
      protocol: task.protocol,
      resource_id: task.resourceId,
      input_json: JSON.stringify(withoutReservedFields(task.input)),
      adapter_data_json: task.adapterData !== undefined ? JSON.stringify(task.adapterData) : null,
      created_at: now,
      expires_at: expiresAt,
    });
    return true;
  });

  return {
    async putPendingTask(task, options) {
      try {
        // A NaN cap would compare false and admit every task
        if (!Number.isInteger(options.maxTasks) || options.maxTasks < 0) {
          throw new CommerceError('STORAGE_ERROR', 'maxTasks must be a non-negative integer');
        }
        return put.immediate(task, options.maxTasks, storedIso(task.expiresAt, 'expiresAt'));
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to store pending task');
      }
    },

    async getPendingTask(id) {
      const row = selectLive.get(id, clock.nowIso());
      return row !== undefined ? rowToTask(row) : undefined;
    },

    async takePendingTask(id) {
      try {
        const now = clock.nowIso();
        // Delete expired task input even if no new purchase arrives
        sweepExpired.run(now);
        const row = takeLive.get(id, now);
        return row !== undefined ? rowToTask(row) : undefined;
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to take pending task');
      }
    },
  };
}
