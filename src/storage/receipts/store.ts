/**
 * SQLite implementation of the frozen ReceiptStore interface.
 *
 * Thin repository layer — no ORM. Every write goes through a prepared
 * statement; the only thing that varies between calls is parameters.
 */
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, existsSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
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
} from '../../core/index.js';
import { PACKAGE_VERSION } from '../../version.js';
import {
  type EventRow,
  eventToRow,
  type PaymentAttemptRow,
  type ReceiptRow,
  receiptToRow,
  rowToEvent,
  rowToPaymentAttempt,
  rowToReceipt,
} from './rows.js';
import { migrate, SCHEMA_VERSION } from './schema.js';

const DEFAULT_LIST_LIMIT = 50;
/**
 * Hard ceiling on every list query, applied here rather than only at the
 * gateway route, so every caller (HTTP, CLI, a future adapter) is covered.
 * SQLite treats a negative `LIMIT` as "no limit" —
 * confirmed `{ limit: -1 }` returns the entire table.
 */
const MAX_LIST_LIMIT = 500;

/**
 * Clamps to a whole number in [1, MAX_LIST_LIMIT], defaulting when absent OR
 * non-finite (NaN/Infinity) — a store-level invariant that must hold
 * regardless of whether the current caller already filters those out.
 */
function clampListLimit(limit: number | undefined): number {
  const base = limit !== undefined && Number.isFinite(limit) ? limit : DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(base), 1), MAX_LIST_LIMIT);
}

export interface SqliteReceiptStoreOptions {
  /** File path, or ':memory:' for tests. Parent directory is created if missing. */
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

/**
 * Narrow the database and its WAL sidecars to owner-only.
 *
 * `new Database(path)` opens with `0666 & ~umask`, so on a
 * standard host the `.sqlite`, `-wal` and `-shm` files landed at 0644 — any
 * other local user could read the whole commerce ledger: payer and payee
 * addresses, amounts, settlement transaction hashes, replay keys and the
 * entire event stream. No key material (the gateway is non-custodial and
 * `redact.ts` is recursive), but business metadata all the same.
 *
 * Called *after* `journal_mode = WAL`, because the sidecars do not exist until
 * then. Best-effort by design: a filesystem without POSIX modes must not stop
 * the gateway from starting, so a failure warns rather than throws.
 */
function restrictDatabasePermissions(path: string, logger: Logger): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      logger.warn(
        { file, error: code ?? 'unknown' },
        'could not restrict receipt database permissions to owner-only',
      );
    }
  }
}

export function createSqliteReceiptStore(options: SqliteReceiptStoreOptions): ReceiptStore {
  const logger = options.logger ?? NOOP_LOGGER;
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? defaultIds;
  const path = options.path;
  const isFileBacked = path !== ':memory:';

  if (isFileBacked) {
    const dir = dirname(path);
    if (dir !== '' && dir !== '.' && !existsSync(dir)) {
      // 0700 on directories we create ourselves. An existing directory is the
      // operator's to own and is deliberately left alone.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  // Fail at startup, not on the first payment. `new Database(path)`
  // happily opens a file the process cannot write, and SQLite only says
  // "attempt to write a readonly database" once a write is attempted — which
  // on a paid resource is *after* the payment attempt reservation, surfacing
  // as an opaque STORAGE_ERROR per request. Readiness does catch it (503), but
  // the operator is left guessing. This is not hypothetical: switching the
  // demo containers to a non-root user left an existing named volume
  // root-owned, and that is exactly how it presented.
  if (isFileBacked && existsSync(path)) {
    try {
      accessSync(path, fsConstants.W_OK);
    } catch {
      throw new CommerceError(
        'STORAGE_ERROR',
        `Receipt database "${path}" exists but is not writable by this process (uid ${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}). If this is a container that recently changed user, an existing volume may still be owned by the previous one — recreate it (docker compose down -v) or fix its ownership.`,
        { details: { path } },
      );
    }
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  if (isFileBacked) restrictDatabasePermissions(path, logger);

  const insertReceiptStmt = db.prepare(
    `INSERT INTO receipts (id, request_id, resource_id, payment_json, delivered_at, backend_status, duration_ms, protocol, metadata_json)
     VALUES (@id, @request_id, @resource_id, @payment_json, @delivered_at, @backend_status, @duration_ms, @protocol, @metadata_json)`,
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
  // backend_status is INTEGER NOT NULL (schema.ts) so NOT BETWEEN never has
  // a NULL row to silently miss; 0 (backend never responded at all) and
  // every non-2xx status both count as undelivered, matching the dashboard's
  // deliveryResult() (ReceiptList.tsx) — the two views must not disagree
  // about what "delivered" means, which is the confusion.
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

  const insertPaymentAttemptStmt = db.prepare(
    `INSERT INTO payment_attempts (id, request_id, resource_id, provider, replay_key, status, amount, currency, payer, payee, external_reference, rejection_reason, created_at, updated_at)
     VALUES (@id, @request_id, @resource_id, @provider, @replay_key, @status, @amount, @currency, @payer, @payee, @external_reference, @rejection_reason, @created_at, @updated_at)`,
  );
  const getPaymentAttemptByIdStmt = db.prepare<[string], PaymentAttemptRow>(
    'SELECT * FROM payment_attempts WHERE id = ?',
  );
  // COALESCE: an omitted field (bound as NULL — see updatePaymentAttempt)
  // means "leave the existing value alone", not "clear it". Without this, a
  // second update that doesn't re-supply external_reference/rejection_reason
  // erases it — exactly the field that carries the on-chain tx hash for a
  // settlement-uncertain attempt, the one record proving the buyer's funds
  // may have moved. There is no current caller that needs to clear an
  // already-set value; if one appears, it needs an explicit sentinel rather
  // than overloading `undefined` to mean two different things again.
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
      // Schema setup already happened synchronously above (better-sqlite3 is
      // sync). This re-check makes init() a meaningful, idempotent gate for
      // callers that treat it as the lifecycle hook that must succeed before
      // any other method is used.
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
      try {
        insertPaymentAttemptStmt.run({
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
        });
      } catch (err) {
        if (isUniqueConstraintOn(err, 'payment_attempts.replay_key')) {
          throw new CommerceError(
            'PAYMENT_REPLAYED',
            `Payment authorisation has already been used (replayKey=${reservation.replayKey})`,
            { requestId: reservation.requestId, resourceId: reservation.resourceId },
          );
        }
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to reserve payment attempt');
      }
      const row = getPaymentAttemptByIdStmt.get(id);
      if (row === undefined) {
        throw new CommerceError(
          'STORAGE_ERROR',
          'Payment attempt vanished immediately after insert',
        );
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

    /** Exact total, ignoring the listReceipts clamp — see the interface doc for why this exists. */
    async countReceipts(): Promise<number> {
      return countReceiptsStmt.get()?.count ?? 0;
    },

    /** Exact count of non-2xx receipts — see the interface doc for why this exists. */
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
      // Same discipline: a client-visible field is authored from a
      // fixed vocabulary, never inherited from a caught error's `.message`.
      // `accessSync` on a real deployment throws e.g.
      // "EACCES: permission denied, access '/workspace/data/receipts.sqlite'"
      // — an absolute host path that must never reach the unauthenticated
      // `/ready` response). The raw message still goes
      // to the injected logger, so nothing is lost for diagnosis.
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
