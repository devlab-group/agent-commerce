/**
 * SQLite implementation of the frozen ReceiptStore interface: a thin layer
 * over statements prepared once at open, with no ORM
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type Clock,
  CommerceError,
  type CommerceEvent,
  type CommerceReceipt,
  type IdGenerator,
  type ListOptions,
  type Logger,
  NOOP_LOGGER,
  type PaymentAttempt,
  type PaymentAttemptReservation,
  type PaymentAttemptUpdate,
  type ReceiptStore,
  systemClock,
  toCommerceError,
} from '../../core';
import { PACKAGE_VERSION } from '../../version';
import { openSqliteDatabase } from '../sqlite';
import {
  type EventRow,
  eventToRow,
  type PaymentAttemptRow,
  type ReceiptRow,
  receiptToRow,
  rowToEvent,
  rowToPaymentAttempt,
  rowToReceipt,
} from './rows';
import { migrate, SCHEMA_VERSION } from './schema';

const DEFAULT_LIST_LIMIT = 50;
/**
 * Ceiling on every list query, enforced in the store so every caller is
 * covered, not only the HTTP route. SQLite reads a negative `LIMIT` as no
 * limit, so `{ limit: -1 }` would otherwise return the whole table.
 */
const MAX_LIST_LIMIT = 500;

// Clamps to a whole number in [1, MAX_LIST_LIMIT]. An absent or non-finite
// limit (NaN, Infinity) takes the default, whether or not the caller filtered
// it first.
function clampListLimit(limit: number | undefined): number {
  const base = limit !== undefined && Number.isFinite(limit) ? limit : DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(base), 1), MAX_LIST_LIMIT);
}

export interface SqliteReceiptStoreOptions {
  /** File path, or ':memory:' for tests. Parent directory is created if missing */
  readonly path: string;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

const defaultIds: IdGenerator = {
  next: (prefix) => (prefix !== undefined ? `${prefix}_${randomUUID()}` : randomUUID()),
};

function isUniqueConstraintOn(err: unknown, column: string): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    err.message.includes(column)
  );
}

export function createSqliteReceiptStore(options: SqliteReceiptStoreOptions): ReceiptStore {
  const logger = options.logger ?? NOOP_LOGGER;
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? defaultIds;
  const path = options.path;
  const isFileBacked = path !== ':memory:';

  // Shared with the ACP idempotency and AP2 replay stores, so the permission
  // hardening has one definition
  const db = openSqliteDatabase({ path, label: 'Receipt database', logger });
  migrate(db);

  const insertReceiptStmt = db.prepare(
    `INSERT INTO receipts (id, request_id, resource_id, payment_json, delivered_at, backend_status, duration_ms, protocol, metadata_json, authorization_json)
     VALUES (@id, @request_id, @resource_id, @payment_json, @delivered_at, @backend_status, @duration_ms, @protocol, @metadata_json, @authorization_json)`,
  );
  const getReceiptStmt = db.prepare<[string], ReceiptRow>('SELECT * FROM receipts WHERE id = ?');
  const listReceiptsStmt = db.prepare<[number], ReceiptRow>(
    'SELECT * FROM receipts ORDER BY delivered_at DESC, seq DESC LIMIT ?',
  );
  const listReceiptsByRequestStmt = db.prepare<[string, number], ReceiptRow>(
    'SELECT * FROM receipts WHERE request_id = ? ORDER BY delivered_at DESC, seq DESC LIMIT ?',
  );
  const countReceiptsStmt = db.prepare<[], { count: number }>(
    'SELECT COUNT(*) AS count FROM receipts',
  );
  // backend_status is NOT NULL, so NOT BETWEEN cannot skip a row. 0 (no status
  // known) and every non-2xx status count as undelivered, the same rule as the
  // dashboard's deliveryResult() in ReceiptList.tsx.
  const countUndeliveredReceiptsStmt = db.prepare<[], { count: number }>(
    'SELECT COUNT(*) AS count FROM receipts WHERE backend_status NOT BETWEEN 200 AND 299',
  );

  const insertEventStmt = db.prepare(
    `INSERT INTO events (id, type, request_id, resource_id, at, adapter, payment_provider, duration_ms, status, data_json)
     VALUES (@id, @type, @request_id, @resource_id, @at, @adapter, @payment_provider, @duration_ms, @status, @data_json)`,
  );
  const listEventsStmt = db.prepare<[number], EventRow>(
    'SELECT * FROM events ORDER BY at DESC, seq DESC LIMIT ?',
  );
  const listEventsByRequestStmt = db.prepare<[string, number], EventRow>(
    'SELECT * FROM events WHERE request_id = ? ORDER BY at DESC, seq DESC LIMIT ?',
  );

  const insertPaymentAttemptStmt = db.prepare<Record<string, unknown>, PaymentAttemptRow>(
    `INSERT INTO payment_attempts (id, request_id, resource_id, provider, replay_key, status, amount, currency, payer, payee, external_reference, rejection_reason, created_at, updated_at)
     VALUES (@id, @request_id, @resource_id, @provider, @replay_key, @status, @amount, @currency, @payer, @payee, @external_reference, @rejection_reason, @created_at, @updated_at)
     RETURNING *`,
  );
  // COALESCE: an omitted field (bound as NULL by updatePaymentAttempt) keeps
  // its stored value. A status-only update must not erase external_reference,
  // which holds the tx hash of a settlement-uncertain attempt: the record that
  // the buyer's funds may have moved. Clearing a value would need an explicit
  // sentinel, not `undefined`.
  const updatePaymentAttemptStmt = db.prepare(
    `UPDATE payment_attempts SET status = @status,
       external_reference = COALESCE(@external_reference, external_reference),
       rejection_reason = COALESCE(@rejection_reason, rejection_reason),
       updated_at = @updated_at
     WHERE replay_key = @replay_key`,
  );
  const listPaymentAttemptsStmt = db.prepare<[number], PaymentAttemptRow>(
    'SELECT * FROM payment_attempts ORDER BY created_at DESC, seq DESC LIMIT ?',
  );
  const listPaymentAttemptsByRequestStmt = db.prepare<[string, number], PaymentAttemptRow>(
    'SELECT * FROM payment_attempts WHERE request_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?',
  );
  const paymentAttemptStatusStmt = db.prepare<[string], Pick<PaymentAttemptRow, 'status'>>(
    'SELECT status FROM payment_attempts WHERE replay_key = ?',
  );

  let closed = false;

  const descriptor: AdapterDescriptor = {
    name: 'sqlite-receipt-store',
    kind: 'storage',
    implementationVersion: PACKAGE_VERSION,
    supportedSpec: `sqlite-schema-v${SCHEMA_VERSION}`,
    capabilities: ['receipts', 'events', 'payment-attempts'],
    status: 'stable',
  };

  const store: ReceiptStore = {
    async init(): Promise<void> {
      // Migration already ran synchronously at construction. This check keeps
      // init() a real, idempotent gate for callers that await it first.
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version !== SCHEMA_VERSION) {
        throw new CommerceError(
          'STORAGE_ERROR',
          `Receipt store schema version mismatch (found ${version}, expected ${SCHEMA_VERSION})`,
        );
      }
    },

    async appendEvent(event: CommerceEvent): Promise<void> {
      try {
        insertEventStmt.run(eventToRow(event));
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            eventId: event.id,
            requestId: event.requestId,
          },
          'receipt-store: failed to persist commerce event',
        );
      }
    },

    async reservePaymentAttempt(reservation: PaymentAttemptReservation): Promise<PaymentAttempt> {
      const now = clock.nowIso();
      const id = ids.next('attempt');
      let row: PaymentAttemptRow;
      try {
        // RETURNING on a successful insert always yields the inserted row
        row = insertPaymentAttemptStmt.get({
          id,
          request_id: reservation.requestId,
          resource_id: reservation.resourceId,
          provider: reservation.provider,
          replay_key: reservation.replayKey,
          status: 'reserved' satisfies PaymentAttempt['status'],
          amount: reservation.amount,
          currency: reservation.currency,
          payer: reservation.payer ?? null,
          payee: reservation.payee ?? null,
          external_reference: null,
          rejection_reason: null,
          created_at: now,
          updated_at: now,
        }) as PaymentAttemptRow;
      } catch (err) {
        if (isUniqueConstraintOn(err, 'payment_attempts.replay_key')) {
          // Report the existing status so the pipeline can choose a replay response
          const existing = paymentAttemptStatusStmt.get(reservation.replayKey);
          throw new CommerceError(
            'PAYMENT_REPLAYED',
            `Payment authorization has already been used (replayKey=${reservation.replayKey})`,
            {
              requestId: reservation.requestId,
              resourceId: reservation.resourceId,
              ...(existing !== undefined ? { details: { attemptStatus: existing.status } } : {}),
            },
          );
        }
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to reserve payment attempt');
      }
      return rowToPaymentAttempt(row);
    },

    async updatePaymentAttempt(update: PaymentAttemptUpdate): Promise<void> {
      try {
        const result = updatePaymentAttemptStmt.run({
          replay_key: update.replayKey,
          status: update.status,
          external_reference: update.externalReference ?? null,
          rejection_reason: update.rejectionReason ?? null,
          updated_at: clock.nowIso(),
        });
        if (result.changes === 0) {
          throw new CommerceError(
            'STORAGE_ERROR',
            `No payment attempt found for replayKey=${update.replayKey}`,
          );
        }
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to update payment attempt');
      }
    },

    async saveReceipt(receipt: CommerceReceipt): Promise<void> {
      try {
        insertReceiptStmt.run(receiptToRow(receipt));
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to save receipt');
      }
    },

    async getReceipt(id: string): Promise<CommerceReceipt | undefined> {
      const row = getReceiptStmt.get(id);
      return row !== undefined ? rowToReceipt(row) : undefined;
    },

    async listReceipts(listOptions: ListOptions = {}): Promise<readonly CommerceReceipt[]> {
      const limit = clampListLimit(listOptions.limit);
      const rows =
        listOptions.requestId !== undefined
          ? listReceiptsByRequestStmt.all(listOptions.requestId, limit)
          : listReceiptsStmt.all(limit);
      return rows.map(rowToReceipt);
    },

    // Exact total, not bounded by the listReceipts clamp (see ReceiptStore.countReceipts)
    async countReceipts(): Promise<number> {
      return countReceiptsStmt.get()?.count ?? 0;
    },

    // Exact count of non-2xx receipts (see ReceiptStore.countUndeliveredReceipts)
    async countUndeliveredReceipts(): Promise<number> {
      return countUndeliveredReceiptsStmt.get()?.count ?? 0;
    },

    async listEvents(listOptions: ListOptions = {}): Promise<readonly CommerceEvent[]> {
      const limit = clampListLimit(listOptions.limit);
      const rows =
        listOptions.requestId !== undefined
          ? listEventsByRequestStmt.all(listOptions.requestId, limit)
          : listEventsStmt.all(limit);
      return rows.map(rowToEvent);
    },

    async listPaymentAttempts(listOptions: ListOptions = {}): Promise<readonly PaymentAttempt[]> {
      const limit = clampListLimit(listOptions.limit);
      const rows =
        listOptions.requestId !== undefined
          ? listPaymentAttemptsByRequestStmt.all(listOptions.requestId, limit)
          : listPaymentAttemptsStmt.all(limit);
      return rows.map(rowToPaymentAttempt);
    },

    descriptor,

    async health(): Promise<AdapterHealth> {
      // `detail` comes from a fixed vocabulary, never from a caught error: an
      // accessSync error carries an absolute host path, e.g. "EACCES:
      // permission denied, access '/workspace/data/receipts.sqlite'". The raw
      // message goes to the logger at warn.
      const startedAt = clock.monotonicMs();
      if (closed) {
        return { status: 'fail', detail: 'store-unavailable', checkedAt: clock.nowIso() };
      }
      if (isFileBacked) {
        try {
          accessSync(path, fsConstants.W_OK);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'receipt-store: health check failed (store not writable)',
          );
          return {
            status: 'fail',
            detail: 'store-unwritable',
            checkedAt: clock.nowIso(),
            durationMs: clock.monotonicMs() - startedAt,
          };
        }
      }
      try {
        const version = db.pragma('user_version', { simple: true }) as number;
        if (version !== SCHEMA_VERSION) {
          logger.warn(
            { found: version, expected: SCHEMA_VERSION },
            'receipt-store: health check failed (schema version mismatch)',
          );
          return {
            status: 'fail',
            detail: 'store-schema-mismatch',
            checkedAt: clock.nowIso(),
            durationMs: clock.monotonicMs() - startedAt,
          };
        }
        return {
          status: 'pass',
          detail: `sqlite schema v${SCHEMA_VERSION} writable`,
          checkedAt: clock.nowIso(),
          durationMs: clock.monotonicMs() - startedAt,
        };
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'receipt-store: health check failed (store unavailable)',
        );
        return {
          status: 'fail',
          detail: 'store-unavailable',
          checkedAt: clock.nowIso(),
          durationMs: clock.monotonicMs() - startedAt,
        };
      }
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };

  return store;
}
