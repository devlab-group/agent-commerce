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
  type IsoTimestamp,
  type ListOptions,
  type Logger,
  NOOP_LOGGER,
  type PaymentAttempt,
  type PaymentAttemptListOptions,
  type PaymentAttemptReservation,
  type PaymentAttemptResolveRequest,
  type PaymentAttemptUpdate,
  type ReceiptListOptions,
  type ReceiptStore,
  systemClock,
  type Transaction,
  type TransactionListOptions,
  type TransactionPage,
  type TransactionStep,
  toCommerceError,
  transactionState,
} from '../../core';
import { PACKAGE_VERSION } from '../../version';
import { openSqliteDatabase } from '../sqlite';
import { redact } from './redact';
import {
  type EventRow,
  eventToRow,
  type PaymentAttemptRow,
  type ReceiptRow,
  receiptToRow,
  rowToEvent,
  rowToPaymentAttempt,
  rowToReceipt,
  rowToTransaction,
  type TransactionRow,
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

// Non-2xx statuses, including 0 (unknown), are undelivered, matching
// deliveryResult() in ReceiptList.tsx. NOT NULL prevents NULL comparisons from
// hiding rows.
const UNDELIVERED = 'backend_status NOT BETWEEN 200 AND 299';

// Statuses needing reconciliation; see ReceiptStore.countUncertainPaymentAttempts
const UNCERTAIN = "status IN ('settlement-uncertain', 'failed')";

// Join each transaction with its payment attempt. Reclaim replaces the live
// attempt's ID and archives the old row, so earlier transactions read their
// attempt from payment_attempt_history.
const TRANSACTION_SELECT = `
  SELECT t.*,
    COALESCE(a.status, h.status) AS payment_status,
    COALESCE(a.amount, h.amount) AS payment_amount,
    COALESCE(a.currency, h.currency) AS payment_currency,
    COALESCE(a.payee, h.payee) AS payment_payee,
    COALESCE(a.external_reference, h.external_reference) AS payment_external_reference
  FROM transactions t
  LEFT JOIN payment_attempts a ON a.id = t.attempt_id
  LEFT JOIN payment_attempt_history h ON a.id IS NULL AND h.seq = (
    SELECT MAX(seq) FROM payment_attempt_history
    WHERE replay_key = t.replay_key AND id = t.attempt_id
  )`;

// Rows without completedAt can change state when backend.deadlineAt passes.
// Include them as filter candidates; transactionState recomputes their state
// on read without a database write.
const TIME_DEPENDENT = 't.backend_deadline_at IS NOT NULL AND t.completed_at IS NULL';
const RESOLVED_STATES = ['delivered', 'payment-failed'] as const;

const CURSOR_PATTERN = /^[1-9][0-9]{0,15}$/;

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
    `INSERT INTO receipts (id, request_id, resource_id, payment_json, delivered_at, backend_status, duration_ms, protocol, metadata_json, authorization_json, transaction_id)
     VALUES (@id, @request_id, @resource_id, @payment_json, @delivered_at, @backend_status, @duration_ms, @protocol, @metadata_json, @authorization_json, @transaction_id)`,
  );
  const getReceiptStmt = db.prepare<[string], ReceiptRow>('SELECT * FROM receipts WHERE id = ?');
  const listReceiptsStmt = db.prepare<[number], ReceiptRow>(
    'SELECT * FROM receipts ORDER BY delivered_at DESC, seq DESC LIMIT ?',
  );
  const listReceiptsByRequestStmt = db.prepare<[string, number], ReceiptRow>(
    'SELECT * FROM receipts WHERE request_id = ? ORDER BY delivered_at DESC, seq DESC LIMIT ?',
  );
  const listUndeliveredReceiptsStmt = db.prepare<[number], ReceiptRow>(
    `SELECT * FROM receipts WHERE ${UNDELIVERED} ORDER BY delivered_at DESC, seq DESC LIMIT ?`,
  );
  const listUndeliveredReceiptsByRequestStmt = db.prepare<[string, number], ReceiptRow>(
    `SELECT * FROM receipts WHERE request_id = ? AND ${UNDELIVERED} ORDER BY delivered_at DESC, seq DESC LIMIT ?`,
  );
  const countReceiptsStmt = db.prepare<[], { count: number }>(
    'SELECT COUNT(*) AS count FROM receipts',
  );
  const countUndeliveredReceiptsStmt = db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM receipts WHERE ${UNDELIVERED}`,
  );

  const insertEventStmt = db.prepare(
    `INSERT INTO events (id, type, request_id, resource_id, at, adapter, payment_provider, duration_ms, status, data_json, transaction_id)
     VALUES (@id, @type, @request_id, @resource_id, @at, @adapter, @payment_provider, @duration_ms, @status, @data_json, @transaction_id)`,
  );
  const listEventsStmt = db.prepare<[number], EventRow>(
    'SELECT * FROM events ORDER BY at DESC, seq DESC LIMIT ?',
  );
  const listEventsByRequestStmt = db.prepare<[string, number], EventRow>(
    'SELECT * FROM events WHERE request_id = ? ORDER BY at DESC, seq DESC LIMIT ?',
  );

  const insertPaymentAttemptStmt = db.prepare<Record<string, unknown>, PaymentAttemptRow>(
    `INSERT INTO payment_attempts (id, request_id, resource_id, provider, replay_key, status, amount, currency, payer, payee, external_reference, rejection_reason, created_at, updated_at, transaction_id)
     VALUES (@id, @request_id, @resource_id, @provider, @replay_key, @status, @amount, @currency, @payer, @payee, @external_reference, @rejection_reason, @created_at, @updated_at, @transaction_id)
     RETURNING *`,
  );
  // Keeps the rejected row a reclaim is about to overwrite
  const archiveRejectedAttemptStmt = db.prepare(
    `INSERT INTO payment_attempt_history (id, request_id, resource_id, provider, replay_key, status, amount, currency, payer, payee, external_reference, rejection_reason, created_at, updated_at, superseded_at, transaction_id, resolution_json)
     SELECT id, request_id, resource_id, provider, replay_key, status, amount, currency, payer, payee, external_reference, rejection_reason, created_at, updated_at, @created_at, transaction_id, resolution_json
     FROM payment_attempts
     WHERE replay_key = @replay_key AND provider = @provider AND status = 'rejected'`,
  );
  const reclaimPaymentAttemptStmt = db.prepare<Record<string, unknown>, PaymentAttemptRow>(
    `UPDATE payment_attempts SET id = @id, request_id = @request_id, resource_id = @resource_id,
       status = 'reserved', amount = @amount, currency = @currency,
       payer = @payer, payee = @payee, external_reference = NULL, rejection_reason = NULL,
       created_at = @created_at, updated_at = @updated_at,
       transaction_id = @transaction_id, resolution_json = NULL
     WHERE replay_key = @replay_key AND provider = @provider AND status = 'rejected'
     RETURNING *`,
  );
  // Omitted fields bind as NULL, so COALESCE preserves stored values. A
  // status-only update must retain external_reference: it may identify funds
  // that already moved. Clearing a field would need an explicit sentinel
  // rather than undefined. Rows with recorded resolutions reject later
  // pipeline updates.
  const updatePaymentAttemptStmt = db.prepare(
    `UPDATE payment_attempts SET status = @status,
       external_reference = COALESCE(@external_reference, external_reference),
       rejection_reason = COALESCE(@rejection_reason, rejection_reason),
       updated_at = @updated_at
     WHERE replay_key = @replay_key AND resolution_json IS NULL`,
  );
  const listPaymentAttemptsStmt = db.prepare<[number], PaymentAttemptRow>(
    'SELECT * FROM payment_attempts ORDER BY created_at DESC, seq DESC LIMIT ?',
  );
  const listPaymentAttemptsByRequestStmt = db.prepare<[string, number], PaymentAttemptRow>(
    'SELECT * FROM payment_attempts WHERE request_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?',
  );
  const listUncertainPaymentAttemptsStmt = db.prepare<[number], PaymentAttemptRow>(
    `SELECT * FROM payment_attempts WHERE ${UNCERTAIN} ORDER BY created_at DESC, seq DESC LIMIT ?`,
  );
  const listUncertainPaymentAttemptsByRequestStmt = db.prepare<[string, number], PaymentAttemptRow>(
    `SELECT * FROM payment_attempts WHERE request_id = ? AND ${UNCERTAIN} ORDER BY created_at DESC, seq DESC LIMIT ?`,
  );
  const countUncertainPaymentAttemptsStmt = db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM payment_attempts WHERE ${UNCERTAIN}`,
  );
  const paymentAttemptStatusStmt = db.prepare<
    [string],
    Pick<PaymentAttemptRow, 'id' | 'status' | 'resolution_json'>
  >('SELECT id, status, resolution_json FROM payment_attempts WHERE replay_key = ?');
  const insertTransactionStmt = db.prepare(
    `INSERT INTO transactions (id, request_id, resource_id, protocol, state, provider, attempt_id, replay_key, network, asset, authorization_json, reservation_id, locator_json, expires_at, input_digest, config_digest, created_at, updated_at)
     VALUES (@id, @request_id, @resource_id, @protocol, @state, @provider, @attempt_id, @replay_key, @network, @asset, @authorization_json, @reservation_id, @locator_json, @expires_at, @input_digest, @config_digest, @created_at, @created_at)`,
  );
  const getTransactionStmt = db.prepare<[string], TransactionRow>(
    `${TRANSACTION_SELECT} WHERE t.id = ?`,
  );
  // After reclaim, purchases can share a replay key but refer to different
  // attempts. Match attempt_id to refresh only the current attempt's transactions;
  // the replay_key condition also permits an indexed lookup.
  const transactionsOfAttemptStmt = db.prepare<[string], { id: string }>(
    `SELECT t.id FROM payment_attempts a
     JOIN transactions t ON t.replay_key = a.replay_key AND t.attempt_id = a.id
     WHERE a.replay_key = ?`,
  );
  const transactionsOfAttemptIdStmt = db.prepare<[string], { id: string }>(
    `SELECT t.id FROM payment_attempts a
     JOIN transactions t ON t.replay_key = a.replay_key AND t.attempt_id = a.id
     WHERE a.id = ?`,
  );
  const setTransactionStateStmt = db.prepare('UPDATE transactions SET state = ? WHERE id = ?');
  const stepStmts = {
    settling: db.prepare(
      'UPDATE transactions SET settling_at = @at, updated_at = @at WHERE id = @id',
    ),
    // A transaction without an authorization has no hold to record
    hold: db.prepare(
      `UPDATE transactions SET authorization_json = json_set(authorization_json, '$.hold', @hold), updated_at = @at
       WHERE id = @id AND authorization_json IS NOT NULL`,
    ),
    'backend-dispatched': db.prepare(
      `UPDATE transactions SET backend_dispatched_at = @at, backend_deadline_at = @deadline_at, updated_at = @at
       WHERE id = @id`,
    ),
    // Preserve a backend result even when the dispatch step was not saved:
    // use the result time for missing dispatch and deadline timestamps
    'backend-result': db.prepare(
      `UPDATE transactions SET backend_status = @status, backend_error_code = @error_code,
         backend_dispatched_at = COALESCE(backend_dispatched_at, @at),
         backend_deadline_at = COALESCE(backend_deadline_at, @at), updated_at = @at
       WHERE id = @id`,
    ),
    receipt: db.prepare(
      'UPDATE transactions SET receipt_id = @receipt_id, updated_at = @at WHERE id = @id',
    ),
    completed: db.prepare(
      `UPDATE transactions SET completed_at = @at, persistence_failures_json = @persistence_failures_json, updated_at = @at
       WHERE id = @id`,
    ),
  } satisfies Record<TransactionStep['kind'], unknown>;
  const getPaymentAttemptStmt = db.prepare<[string], PaymentAttemptRow>(
    'SELECT * FROM payment_attempts WHERE id = ?',
  );
  const getArchivedPaymentAttemptStmt = db.prepare<[string], PaymentAttemptRow>(
    'SELECT * FROM payment_attempt_history WHERE id = ? ORDER BY seq DESC LIMIT 1',
  );
  // Check status and missing resolution in the UPDATE so only one resolver
  // succeeds. Only reconciliation may replace the attempt's reference; manual
  // references belong in resolution_json.
  const resolvePaymentAttemptStmt = db.prepare(
    `UPDATE payment_attempts SET status = @status,
       rejection_reason = COALESCE(@rejection_reason, rejection_reason),
       external_reference = COALESCE(@external_reference, external_reference),
       resolution_json = @resolution_json, updated_at = @updated_at
     WHERE id = @id AND status = @expected_status AND resolution_json IS NULL`,
  );

  // Refresh the cached state inside the transaction that updated its inputs
  function refreshTransactionState(id: string, now: IsoTimestamp): void {
    const row = getTransactionStmt.get(id);
    if (row !== undefined) setTransactionStateStmt.run(rowToTransaction(row, now).state, id);
  }

  // IMMEDIATE locks before checking the replay key. Once a rejected attempt is
  // reserved again, a competing claim hits the unique replay-key constraint.
  // Journal creation shares the transaction, so a failure also rolls back the
  // attempt insert or reclaim.
  const reserve = db.transaction(
    (
      reservation: PaymentAttemptReservation,
      params: Record<string, unknown>,
    ): PaymentAttemptRow => {
      let row: PaymentAttemptRow | undefined;
      // Reclaim only if the rail permits reusing an authorization whose
      // attempt was rejected. NEAR client retries reuse the access key's
      // next nonce and therefore the replay key.
      if (reservation.reclaimRejected === true) {
        archiveRejectedAttemptStmt.run(params);
        row = reclaimPaymentAttemptStmt.get(params);
      }
      // RETURNING on a successful insert always yields the inserted row
      row ??= insertPaymentAttemptStmt.get({
        ...params,
        status: 'reserved' satisfies PaymentAttempt['status'],
        external_reference: null,
        rejection_reason: null,
      }) as PaymentAttemptRow;
      const txn = reservation.transaction;
      if (txn !== undefined) {
        const { reservationId, ...authorization } = txn.authorization ?? {};
        insertTransactionStmt.run({
          id: txn.id,
          request_id: reservation.requestId,
          resource_id: reservation.resourceId,
          protocol: txn.protocol,
          state: transactionState({ payment: { status: 'reserved' } }, row.created_at),
          provider: reservation.provider,
          attempt_id: row.id,
          replay_key: reservation.replayKey,
          network: txn.network ?? null,
          asset: txn.asset ?? null,
          authorization_json:
            reservationId !== undefined
              ? JSON.stringify(redact({ ...authorization, hold: 'reserved' }))
              : null,
          reservation_id: reservationId ?? null,
          locator_json: txn.locator !== undefined ? JSON.stringify(redact(txn.locator)) : null,
          expires_at: txn.expiresAt ?? null,
          input_digest: txn.inputDigest ?? null,
          config_digest: txn.configDigest,
          created_at: row.created_at,
        });
      }
      return row;
    },
  );
  const updateAttempt = db.transaction((update: PaymentAttemptUpdate, now: IsoTimestamp) => {
    const { changes } = updatePaymentAttemptStmt.run({
      replay_key: update.replayKey,
      status: update.status,
      external_reference: update.externalReference ?? null,
      rejection_reason: update.rejectionReason ?? null,
      updated_at: now,
    });
    for (const { id } of transactionsOfAttemptStmt.all(update.replayKey)) {
      refreshTransactionState(id, now);
    }
    return changes;
  });
  const recordStep = db.transaction((step: TransactionStep): number => {
    const base = { id: step.transactionId, at: step.at };
    let changes: number;
    switch (step.kind) {
      case 'settling':
        changes = stepStmts.settling.run(base).changes;
        break;
      case 'hold':
        changes = stepStmts.hold.run({ ...base, hold: step.hold }).changes;
        break;
      case 'backend-dispatched':
        changes = stepStmts['backend-dispatched'].run({
          ...base,
          deadline_at: step.deadlineAt,
        }).changes;
        break;
      case 'backend-result':
        changes = stepStmts['backend-result'].run({
          ...base,
          status: step.status,
          error_code: step.errorCode ?? null,
        }).changes;
        break;
      case 'receipt':
        changes = stepStmts.receipt.run({ ...base, receipt_id: step.receiptId }).changes;
        break;
      case 'completed':
        changes = stepStmts.completed.run({
          ...base,
          persistence_failures_json:
            step.persistenceFailures !== undefined && step.persistenceFailures.length > 0
              ? JSON.stringify(step.persistenceFailures)
              : null,
        }).changes;
        break;
    }
    if (changes > 0) refreshTransactionState(step.transactionId, step.at);
    return changes;
  });
  const resolveAttempt = db.transaction(
    (request: PaymentAttemptResolveRequest, now: IsoTimestamp): boolean => {
      const { changes } = resolvePaymentAttemptStmt.run({
        id: request.attemptId,
        expected_status: request.expectedStatus,
        status: request.status,
        rejection_reason: request.rejectionReason ?? null,
        // An operator's reference is unverified; it stays in resolution_json only
        external_reference:
          request.resolution.method === 'reconcile'
            ? (request.resolution.externalReference ?? null)
            : null,
        resolution_json: JSON.stringify(redact(request.resolution)),
        updated_at: now,
      });
      if (changes === 0) return false;
      for (const { id } of transactionsOfAttemptIdStmt.all(request.attemptId)) {
        refreshTransactionState(id, now);
      }
      return true;
    },
  );

  let closed = false;

  const descriptor: AdapterDescriptor = {
    name: 'sqlite-receipt-store',
    kind: 'storage',
    implementationVersion: PACKAGE_VERSION,
    supportedSpec: `sqlite-schema-v${SCHEMA_VERSION}`,
    capabilities: ['receipts', 'events', 'payment-attempts', 'transactions'],
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
      const params = {
        id: ids.next('attempt'),
        request_id: reservation.requestId,
        resource_id: reservation.resourceId,
        provider: reservation.provider,
        replay_key: reservation.replayKey,
        amount: reservation.amount,
        currency: reservation.currency,
        payer: reservation.payer ?? null,
        payee: reservation.payee ?? null,
        created_at: now,
        updated_at: now,
        transaction_id: reservation.transaction?.id ?? null,
      };
      let row: PaymentAttemptRow;
      try {
        row = reserve.immediate(reservation, params);
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
        if (updateAttempt(update, clock.nowIso()) === 0) {
          const existing = paymentAttemptStatusStmt.get(update.replayKey);
          if (existing?.resolution_json != null) {
            // Log the rejected update at warn level while preserving the resolution
            logger.warn(
              {
                attemptId: existing.id,
                resolvedStatus: existing.status,
                status: update.status,
                ...(update.externalReference !== undefined
                  ? { externalReference: update.externalReference }
                  : {}),
              },
              'receipt-store: payment attempt already resolved; update not applied',
            );
            throw new CommerceError(
              'STORAGE_ERROR',
              `Payment attempt ${existing.id} is already resolved; the update was not applied`,
            );
          }
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

    async listReceipts(listOptions: ReceiptListOptions = {}): Promise<readonly CommerceReceipt[]> {
      const limit = clampListLimit(listOptions.limit);
      const undelivered = listOptions.undelivered === true;
      const rows =
        listOptions.requestId !== undefined
          ? (undelivered ? listUndeliveredReceiptsByRequestStmt : listReceiptsByRequestStmt).all(
              listOptions.requestId,
              limit,
            )
          : (undelivered ? listUndeliveredReceiptsStmt : listReceiptsStmt).all(limit);
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

    async countUncertainPaymentAttempts(): Promise<number> {
      return countUncertainPaymentAttemptsStmt.get()?.count ?? 0;
    },

    async listEvents(listOptions: ListOptions = {}): Promise<readonly CommerceEvent[]> {
      const limit = clampListLimit(listOptions.limit);
      const rows =
        listOptions.requestId !== undefined
          ? listEventsByRequestStmt.all(listOptions.requestId, limit)
          : listEventsStmt.all(limit);
      return rows.map(rowToEvent);
    },

    async listPaymentAttempts(
      listOptions: PaymentAttemptListOptions = {},
    ): Promise<readonly PaymentAttempt[]> {
      const limit = clampListLimit(listOptions.limit);
      const uncertain = listOptions.uncertain === true;
      const rows =
        listOptions.requestId !== undefined
          ? (uncertain
              ? listUncertainPaymentAttemptsByRequestStmt
              : listPaymentAttemptsByRequestStmt
            ).all(listOptions.requestId, limit)
          : (uncertain ? listUncertainPaymentAttemptsStmt : listPaymentAttemptsStmt).all(limit);
      return rows.map(rowToPaymentAttempt);
    },

    async recordTransactionStep(step: TransactionStep): Promise<void> {
      try {
        if (recordStep(step) === 0) {
          throw new CommerceError(
            'STORAGE_ERROR',
            step.kind === 'hold'
              ? `No transaction with an authorization hold found for transactionId=${step.transactionId}`
              : `No transaction found for transactionId=${step.transactionId}`,
          );
        }
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to record transaction step');
      }
    },

    async getTransaction(id: string): Promise<Transaction | undefined> {
      const row = getTransactionStmt.get(id);
      return row !== undefined ? rowToTransaction(row, clock.nowIso()) : undefined;
    },

    async listTransactions(listOptions: TransactionListOptions = {}): Promise<TransactionPage> {
      const { cursor, state, unresolved, pendingHold, requestId } = listOptions;
      if (cursor !== undefined && !CURSOR_PATTERN.test(cursor)) {
        throw new CommerceError('INPUT_INVALID', 'Malformed transaction list cursor');
      }
      const limit = clampListLimit(listOptions.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      if (cursor !== undefined) {
        where.push('t.seq < ?');
        params.push(Number(cursor));
      }
      if (requestId !== undefined) {
        where.push('t.request_id = ?');
        params.push(requestId);
      }
      if (state !== undefined) {
        where.push(`(t.state = ? OR (${TIME_DEPENDENT}))`);
        params.push(state);
      }
      if (pendingHold === true) {
        where.push("json_extract(t.authorization_json, '$.hold') IN ('reserved', 'uncertain')");
      }
      if (unresolved === true) {
        where.push(`t.state NOT IN (${RESOLVED_STATES.map(() => '?').join(', ')})`);
        params.push(...RESOLVED_STATES);
      }
      const rows = db
        .prepare<unknown[], TransactionRow>(
          `${TRANSACTION_SELECT}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.seq DESC LIMIT ?`,
        )
        .all(...params, limit);
      const now = clock.nowIso();
      const resolved: readonly string[] = RESOLVED_STATES;
      const transactions = rows
        .map((row) => rowToTransaction(row, now))
        .filter(
          (t) =>
            (state === undefined || t.state === state) &&
            (unresolved !== true || !resolved.includes(t.state)),
        );
      // Base the cursor on candidate rows, including any removed by the filter
      const last = rows.at(-1);
      return {
        transactions,
        ...(rows.length === limit && last !== undefined ? { nextCursor: String(last.seq) } : {}),
      };
    },

    async getPaymentAttempt(id: string): Promise<PaymentAttempt | undefined> {
      const row = getPaymentAttemptStmt.get(id) ?? getArchivedPaymentAttemptStmt.get(id);
      return row !== undefined ? rowToPaymentAttempt(row) : undefined;
    },

    async resolvePaymentAttempt(request: PaymentAttemptResolveRequest): Promise<boolean> {
      try {
        return resolveAttempt(request, clock.nowIso());
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to resolve payment attempt');
      }
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
