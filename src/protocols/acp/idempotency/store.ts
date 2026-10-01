/**
 * Durable ACP checkout idempotency, in its own database file: it is protocol
 * replay semantics for a checkout, unrelated to the payment replay defense in
 * the receipt store, with its own lifetime and retention.
 *
 * A key is claimed atomically before the side effect starts, so a second
 * request with the same key finds the claim instead of starting a second
 * checkout.
 *
 * A merchant call over HTTP and a SQLite commit are not one transaction. An
 * attempt that reached the merchant and ended in a timeout, a merchant status
 * ACP cannot relay or a non-ACP reply is marked `unresolved`: the merchant may
 * have acted, so every retry of the key is refused rather than re-run, which
 * could charge a buyer twice. A row still `in_flight` when the store opens was
 * never finalized by an earlier process, which crashed or failed to write the
 * outcome, so it is marked `unresolved` too. That assumes one gateway process
 * per database file.
 *
 * Only `completed` rows expire. Deleting an unresolved one would hand the next
 * retry a clean key; clearing it is an operator's decision, taken against the
 * merchant's own records. The merchant should still be idempotent on
 * destructive operations: this store does not make its API exactly-once.
 */
import type { Database } from 'better-sqlite3';
import { type Logger, NOOP_LOGGER } from '../../../core';
import { openSqliteDatabase } from '../../../storage/sqlite';

// v2 keys rows by the deployment's public base URL; v1 keyed them by a
// bearer-token digest (see `migrate`)
const SCHEMA_VERSION = 2;

/** Longest `Idempotency-Key` ACP allows */
export const ACP_MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Scope of one claim: which deployment, which endpoint, which key */
export interface AcpIdempotencyScope {
  /**
   * The gateway's public base URL, not a credential: a rotated token must not
   * give a retry a fresh key and re-run an operation whose outcome may be
   * unknown. The URL survives rotation and still separates two gateways in
   * front of one merchant. It is not secret and is stored as-is, so an
   * operator can see which deployment wrote an unresolved row.
   */
  readonly deployment: string;
  /** The concrete endpoint path, so one key may be reused across operations */
  readonly endpoint: string;
  readonly key: string;
}

/** A response worth replaying: status plus the ACP document that was sent */
export interface AcpStoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type AcpIdempotencyClaim =
  /** The caller owns the key and must now do the work */
  | { readonly kind: 'reserved' }
  /** Same scope, same body, still running elsewhere */
  | { readonly kind: 'in-flight' }
  /** Same scope, same body, and an earlier attempt's outcome was never learned */
  | { readonly kind: 'unresolved' }
  /** Same scope, different body: the key was reused for another request */
  | { readonly kind: 'conflict' }
  /** Same scope, same body, already answered */
  | ({ readonly kind: 'replay' } & AcpStoredResponse);

export interface AcpIdempotencyStore {
  /** Atomically claim `scope`, or report what already holds it */
  claim(scope: AcpIdempotencyScope, fingerprint: string): AcpIdempotencyClaim;
  /** Store the answer, making later retries a replay */
  complete(scope: AcpIdempotencyScope, response: AcpStoredResponse): void;
  /**
   * Keep the claim with no answer: the merchant may have acted. Later retries
   * are refused, neither replayed nor re-run.
   */
  markUnresolved(scope: AcpIdempotencyScope): void;
  /**
   * Drop the claim so a clean retry can run. Only for an attempt that provably
   * never reached the merchant: after an ambiguous failure, one operation
   * could happen twice.
   */
  release(scope: AcpIdempotencyScope): void;
  close(): void;
}

export interface AcpIdempotencyStoreOptions {
  /** File path, or ':memory:' for tests */
  readonly path: string;
  /** Never below 24 hours; config enforces the floor */
  readonly retentionHours: number;
  readonly logger?: Logger;
  /** Injectable for tests that need to move time */
  readonly now?: () => number;
}

interface ClaimRow {
  state: string;
  fingerprint: string;
  status: number | null;
  body_json: string | null;
}

export function createAcpIdempotencyStore(
  options: AcpIdempotencyStoreOptions,
): AcpIdempotencyStore {
  const logger = options.logger ?? NOOP_LOGGER;
  const now = options.now ?? (() => Date.now());
  const retentionMs = options.retentionHours * 60 * 60 * 1000;

  const db: Database = openSqliteDatabase({
    path: options.path,
    label: 'ACP idempotency database',
    logger,
  });
  migrate(db, logger);
  resolveOrphanedClaims(db, logger);

  const selectStmt = db.prepare<[string, string, string], ClaimRow>(
    `SELECT state, fingerprint, status, body_json FROM acp_idempotency
      WHERE deployment = ? AND endpoint = ? AND idempotency_key = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO acp_idempotency
       (deployment, endpoint, idempotency_key, fingerprint, state, created_at, expires_at)
     VALUES (@deployment, @endpoint, @idempotency_key, @fingerprint, 'in_flight', @created_at, @expires_at)`,
  );
  const completeStmt = db.prepare(
    `UPDATE acp_idempotency SET state = 'completed', status = @status, body_json = @body_json
      WHERE deployment = @deployment AND endpoint = @endpoint AND idempotency_key = @idempotency_key`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM acp_idempotency
      WHERE deployment = ? AND endpoint = ? AND idempotency_key = ?`,
  );
  const unresolvedStmt = db.prepare(
    `UPDATE acp_idempotency SET state = 'unresolved'
      WHERE deployment = @deployment AND endpoint = @endpoint AND idempotency_key = @idempotency_key`,
  );
  // Completed rows only: to the next retry, a deleted unresolved row would look
  // like an operation that never happened
  const expireStmt = db.prepare(
    "DELETE FROM acp_idempotency WHERE expires_at <= ? AND state = 'completed'",
  );

  // Expired rows are swept lazily inside the claim transaction, with no
  // background worker
  const claimTx = db.transaction(
    (scope: AcpIdempotencyScope, fingerprint: string): AcpIdempotencyClaim => {
      const at = now();
      expireStmt.run(new Date(at).toISOString());

      const existing = selectStmt.get(scope.deployment, scope.endpoint, scope.key);
      if (existing === undefined) {
        insertStmt.run({
          deployment: scope.deployment,
          endpoint: scope.endpoint,
          idempotency_key: scope.key,
          fingerprint,
          created_at: new Date(at).toISOString(),
          expires_at: new Date(at + retentionMs).toISOString(),
        });
        return { kind: 'reserved' };
      }

      // Fingerprint first: a key reused for a different body conflicts whether
      // or not the first request has finished, and "in flight" would invite a
      // retry that can only conflict
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (existing.state === 'unresolved') return { kind: 'unresolved' };
      if (existing.state !== 'completed') return { kind: 'in-flight' };
      return {
        kind: 'replay',
        status: existing.status ?? 500,
        body: existing.body_json === null ? null : JSON.parse(existing.body_json),
      };
    },
  );

  let closed = false;
  return {
    claim(scope, fingerprint) {
      return claimTx(scope, fingerprint);
    },
    complete(scope, response) {
      completeStmt.run({
        deployment: scope.deployment,
        endpoint: scope.endpoint,
        idempotency_key: scope.key,
        status: response.status,
        body_json: JSON.stringify(response.body ?? null),
      });
    },
    markUnresolved(scope) {
      unresolvedStmt.run({
        deployment: scope.deployment,
        endpoint: scope.endpoint,
        idempotency_key: scope.key,
      });
    },
    release(scope) {
      deleteStmt.run(scope.deployment, scope.endpoint, scope.key);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

// Runs when the store opens, before this process claims anything, so an
// `in_flight` row outlived the process that claimed it and would otherwise
// answer "retry later" forever
function resolveOrphanedClaims(db: Database, logger: Logger): void {
  const { changes } = db
    .prepare("UPDATE acp_idempotency SET state = 'unresolved' WHERE state = 'in_flight'")
    .run();
  if (changes > 0) {
    logger.warn(
      { unresolved: changes },
      'acp idempotency: marked claims left in flight by an earlier process as unresolved; ' +
        'reconcile these operations against the merchant before trusting a retry',
    );
  }
}

// `PRAGMA user_version` marks the schema, so reopening a current file is a no-op
function migrate(db: Database, logger: Logger): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  const apply = db.transaction(() => {
    if (current === 1) {
      // v1 keyed rows by a one-way digest of the bearer token, which cannot be
      // mapped to a deployment. The table is rebuilt empty, since nothing would
      // ever match those rows again, and the number of open claims dropped is
      // logged.
      const carried = db
        .prepare("SELECT COUNT(*) AS count FROM acp_idempotency WHERE state != 'completed'")
        .get() as { count: number };
      if (carried.count > 0) {
        logger.warn(
          { unresolved: carried.count },
          'acp idempotency: schema v1 -> v2 discards claims keyed by the old bearer-token digest; ' +
            'reconcile these operations against the merchant before trusting a retry',
        );
      }
      db.exec('DROP TABLE acp_idempotency');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS acp_idempotency (
        deployment       TEXT NOT NULL,
        endpoint         TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        fingerprint      TEXT NOT NULL,
        state            TEXT NOT NULL,
        status           INTEGER,
        body_json        TEXT,
        created_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        PRIMARY KEY (deployment, endpoint, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_acp_idempotency_expires_at
        ON acp_idempotency(expires_at);
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  apply();
}
