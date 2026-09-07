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
 * `in_flight` and every retry of that key is answered 409 until it expires -
 * deliberately, because re-running a completion whose remote state is unknown
 * risks charging a buyer twice. Merchant-side idempotency on destructive
 * operations is still strongly recommended; this store does not make the
 * merchant's API exactly-once.
 */
import type { Database } from 'better-sqlite3';
import { type Logger, NOOP_LOGGER } from '../../../core/index.js';
import { openSqliteDatabase } from '../../../storage/sqlite.js';

/** Longest `Idempotency-Key` ACP allows. */
export const ACP_MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Scope of one claim: who asked, which endpoint, which key. */
export interface AcpIdempotencyScope {
  /** Digest of the authenticated bearer token - never the token itself. */
  readonly identityHash: string;
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
  /** Same scope, different body: the key was reused for another request. */
  | { readonly kind: 'conflict' }
  /** Same scope, same body, already answered. */
  | ({ readonly kind: 'replay' } & AcpStoredResponse);

export interface AcpIdempotencyStore {
  /** Atomically claim `scope`, or report what already holds it. */
  claim(scope: AcpIdempotencyScope, fingerprint: string): AcpIdempotencyClaim;
  /** Store the answer, making later retries a replay. */
  complete(scope: AcpIdempotencyScope, response: AcpStoredResponse): void;
  /** Drop the claim so a clean retry can run: the attempt produced no answer worth keeping. */
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
  migrate(db);

  const selectStmt = db.prepare<[string, string, string], ClaimRow>(
    `SELECT state, fingerprint, status, body_json FROM acp_idempotency
      WHERE identity_hash = ? AND endpoint = ? AND idempotency_key = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO acp_idempotency
       (identity_hash, endpoint, idempotency_key, fingerprint, state, created_at, expires_at)
     VALUES (@identity_hash, @endpoint, @idempotency_key, @fingerprint, 'in_flight', @created_at, @expires_at)`,
  );
  const completeStmt = db.prepare(
    `UPDATE acp_idempotency SET state = 'completed', status = @status, body_json = @body_json
      WHERE identity_hash = @identity_hash AND endpoint = @endpoint AND idempotency_key = @idempotency_key`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM acp_idempotency
      WHERE identity_hash = ? AND endpoint = ? AND idempotency_key = ?`,
  );
  const expireStmt = db.prepare('DELETE FROM acp_idempotency WHERE expires_at <= ?');

  /**
   * Lazy cleanup, on the same connection and inside the claim transaction: a
   * background worker would be a second moving part for something a request
   * already has to touch.
   */
  const claimTx = db.transaction(
    (scope: AcpIdempotencyScope, fingerprint: string): AcpIdempotencyClaim => {
      const at = now();
      expireStmt.run(new Date(at).toISOString());

      const existing = selectStmt.get(scope.identityHash, scope.endpoint, scope.key);
      if (existing === undefined) {
        insertStmt.run({
          identity_hash: scope.identityHash,
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
        identity_hash: scope.identityHash,
        endpoint: scope.endpoint,
        idempotency_key: scope.key,
        status: response.status,
        body_json: JSON.stringify(response.body ?? null),
      });
    },
    release(scope) {
      deleteStmt.run(scope.identityHash, scope.endpoint, scope.key);
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
function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= 1) return;
  const apply = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS acp_idempotency (
        identity_hash    TEXT NOT NULL,
        endpoint         TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        fingerprint      TEXT NOT NULL,
        state            TEXT NOT NULL,
        status           INTEGER,
        body_json        TEXT,
        created_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        PRIMARY KEY (identity_hash, endpoint, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_acp_idempotency_expires_at
        ON acp_idempotency(expires_at);
    `);
    db.pragma('user_version = 1');
  });
  apply();
}
