/**
 * Durable ACP checkout idempotency.
 *
 * Its own table in its own database file: this is protocol replay semantics for
 * a merchant checkout, and it has nothing to do with the x402 payment replay
 * defence in the receipt store. Sharing a table would tie two unrelated
 * lifetimes and two unrelated retention policies together.
 *
 * The reservation is what makes it safe. A key is claimed atomically *before*
 * the side effect starts, so a second request carrying the same key finds the
 * claim rather than starting a second checkout.
 *
 * What this cannot do: a merchant side effect over HTTP and a local SQLite
 * commit are not one transaction. If the process dies after the merchant
 * completed an order but before the response was stored, the row stays
 * `in_flight` and every retry of that key is refused - deliberately, because
 * re-running a completion whose remote state is unknown risks charging a
 * buyer twice. The third state, `unresolved`, is the same reasoning applied
 * to an attempt that reached the merchant and came back as a timeout, a 5xx
 * or a document we could not read. None of those say nothing happened, so
 * the claim is kept rather than freed for a retry that could order twice.
 *
 * Only a `completed` row expires. An unresolved one is the record that a
 * duplicate is possible, so a retention sweep deleting it would hand the next
 * retry a clean key and re-create the problem the state exists to prevent.
 * Clearing one is an operator's decision, taken against the merchant's own
 * records.
 *
 * Merchant-side idempotency on destructive operations is still strongly
 * recommended; this store does not make the merchant's API exactly-once.
 */
import type { Database } from 'better-sqlite3';
import { type Logger, NOOP_LOGGER } from '../../../core/index.js';
import { openSqliteDatabase } from '../../../storage/sqlite.js';

/**
 * v2 replaced the bearer-token digest in the primary key with the deployment's
 * public base URL. See `migrate`: the upgrade discards v1 rows rather than
 * translating keys it cannot translate.
 */
const SCHEMA_VERSION = 2;

/** Longest `Idempotency-Key` ACP allows. */
export const ACP_MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Scope of one claim: which deployment, which endpoint, which key. */
export interface AcpIdempotencyScope {
  /**
   * The gateway's public base URL.
   *
   * Not a digest of the bearer token, which this was until a rotation turned
   * out to free every claim: a new token is a new key, so a retry finds no
   * row, reserves a fresh one, and re-runs an operation whose outcome may
   * already be unknown. A credential must not be able to do that. The base
   * URL survives rotation, is already configuration, and still separates two
   * gateways fronting the same merchant backend.
   *
   * It is not a secret and is stored as-is, so an operator reading an
   * unresolved row can see which deployment produced it.
   */
  readonly deployment: string;
  /** The concrete endpoint path, so one key may be reused across operations. */
  readonly endpoint: string;
  readonly key: string;
}

/** A response worth replaying: status plus the ACP document that was sent. */
export interface AcpStoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type AcpIdempotencyClaim =
  /** The caller owns the key and must now do the work. */
  | { readonly kind: 'reserved' }
  /** Same scope, same body, still running elsewhere. */
  | { readonly kind: 'in-flight' }
  /** Same scope, same body, and an earlier attempt's outcome was never learned. */
  | { readonly kind: 'unresolved' }
  /** Same scope, different body: the key was reused for another request. */
  | { readonly kind: 'conflict' }
  /** Same scope, same body, already answered. */
  | ({ readonly kind: 'replay' } & AcpStoredResponse);

export interface AcpIdempotencyStore {
  /** Atomically claim `scope`, or report what already holds it. */
  claim(scope: AcpIdempotencyScope, fingerprint: string): AcpIdempotencyClaim;
  /** Store the answer, making later retries a replay. */
  complete(scope: AcpIdempotencyScope, response: AcpStoredResponse): void;
  /**
   * Keep the claim, with no answer: the merchant may have acted and we cannot
   * say. Later retries are refused rather than replayed or re-run.
   */
  markUnresolved(scope: AcpIdempotencyScope): void;
  /**
   * Drop the claim so a clean retry can run.
   *
   * Only for an attempt that provably never reached the merchant. Calling it
   * after an ambiguous failure is what lets one operation happen twice.
   */
  release(scope: AcpIdempotencyScope): void;
  close(): void;
}

export interface AcpIdempotencyStoreOptions {
  /** File path, or ':memory:' for tests. */
  readonly path: string;
  /** Never below 24 hours - config enforces the floor. */
  readonly retentionHours: number;
  readonly logger?: Logger;
  /** Injectable for tests that need to move time. */
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
  // `state = 'completed'` is the whole point: a row holding an unknown
  // merchant outcome outlives retention, because to the next retry, deleting
  // it looks exactly like the operation never having happened
  const expireStmt = db.prepare(
    "DELETE FROM acp_idempotency WHERE expires_at <= ? AND state = 'completed'",
  );

  /**
   * Lazy cleanup, on the same connection and inside the claim transaction: a
   * background worker would be a second moving part for something a request
   * already has to touch.
   */
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

      // Fingerprint first: a key reused for a different request is a conflict
      // whether or not the first one has finished. Reporting "in flight" there
      // would invite a retry that can only ever conflict.
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

/**
 * `PRAGMA user_version` as the migration marker, so reopening an existing file
 * is a fast no-op check rather than a re-create.
 */
function migrate(db: Database, logger: Logger): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  const apply = db.transaction(() => {
    if (current === 1) {
      // v1 keyed every row by a digest of the bearer token. Those keys cannot
      // be translated forward: the digest is one-way, and what it stood for
      // was the credential, not the deployment. So the table is rebuilt empty
      // - the one time orphaning a claim is right, because leaving rows that
      // nothing will ever match again is worse than saying they are gone.
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
