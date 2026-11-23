/**
 * Store task responses as JSON for later reads. Documents are not redacted;
 * callers must exclude payment proofs and authorization presentations.
 */
import type Database from 'better-sqlite3';
import { type Clock, CommerceError, type TaskRecord, toCommerceError } from '../../core';
import type { StoreGroupMethods } from '../../core/store-method-groups';
import { storedIso } from './params';

interface RecordRow {
  id: string;
  protocol: string;
  group_id: string;
  state: string;
  updated_at: string;
  document_json: string;
  expires_at: string;
  evictable: number;
}

type TaskRecordMethods = StoreGroupMethods<'task_records'>;

function rowToRecord(row: RecordRow): TaskRecord {
  return {
    id: row.id,
    protocol: row.protocol as TaskRecord['protocol'],
    groupId: row.group_id,
    state: row.state,
    updatedAt: row.updated_at,
    document: JSON.parse(row.document_json),
    expiresAt: row.expires_at,
    ...(row.evictable === 1 ? { evictable: true } : {}),
  };
}

const SWEEP_EXPIRED = 'DELETE FROM task_records WHERE expires_at <= ?';

/** Delete expired task records during writable-store initialization */
export function sweepExpiredTaskRecords(db: Database.Database, now: string): void {
  db.prepare(SWEEP_EXPIRED).run(now);
}

export function createTaskRecordMethods(db: Database.Database, clock: Clock): TaskRecordMethods {
  const sweepExpired = db.prepare(SWEEP_EXPIRED);
  // Count after the expiry sweep so expired rows do not consume capacity
  const countAll = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM task_records');
  const hasId = db.prepare<[string], { id: string }>('SELECT id FROM task_records WHERE id = ?');
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO task_records
       (id, protocol, group_id, state, updated_at, document_json, expires_at, evictable)
     VALUES (@id, @protocol, @group_id, @state, @updated_at, @document_json, @expires_at, @evictable)`,
  );
  const evictOldest = db.prepare<[number]>(
    `DELETE FROM task_records WHERE id IN
       (SELECT id FROM task_records WHERE evictable = 1 ORDER BY updated_at, id LIMIT ?)`,
  );
  const selectLive = db.prepare<[string, string], RecordRow>(
    'SELECT * FROM task_records WHERE id = ? AND expires_at > ?',
  );
  // ponytail: read the whole group at once; add store pagination when groups become large
  const listLive = db.prepare<[string, string, string], RecordRow>(
    `SELECT * FROM task_records WHERE protocol = ? AND group_id = ? AND expires_at > ?
      ORDER BY updated_at DESC, id DESC`,
  );

  const put = db.transaction((row: RecordRow, maxRecords: number): boolean => {
    sweepExpired.run(clock.nowIso());
    // Replacing an existing ID does not count against the record limit
    if (hasId.get(row.id) === undefined) {
      const count = countAll.get()?.count ?? 0;
      // A lower limit may require evicting more than one record
      if (
        count >= maxRecords &&
        count - evictOldest.run(count - maxRecords + 1).changes >= maxRecords
      ) {
        return false;
      }
    }
    upsert.run(row);
    return true;
  });

  return {
    async putTaskRecord(record, options) {
      try {
        // Reject NaN, which would bypass the capacity comparison
        if (!Number.isInteger(options.maxRecords) || options.maxRecords < 0) {
          throw new CommerceError('STORAGE_ERROR', 'maxRecords must be a non-negative integer');
        }
        const row: RecordRow = {
          id: record.id,
          protocol: record.protocol,
          group_id: record.groupId,
          state: record.state,
          updated_at: storedIso(record.updatedAt, 'updatedAt'),
          document_json: JSON.stringify(record.document),
          expires_at: storedIso(record.expiresAt, 'expiresAt'),
          evictable: record.evictable === true ? 1 : 0,
        };
        return put.immediate(row, options.maxRecords);
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to store task record');
      }
    },

    async getTaskRecord(id) {
      const row = selectLive.get(id, clock.nowIso());
      return row !== undefined ? rowToRecord(row) : undefined;
    },

    async listTaskRecords({ protocol, groupId }) {
      return listLive.all(protocol, groupId, clock.nowIso()).map(rowToRecord);
    },
  };
}
