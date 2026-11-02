/**
 * Receipt-store schema migrations. `PRAGMA user_version` records the applied
 * version, so a restart against an existing file keeps its data.
 */
import type Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  up(db: Database.Database): void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS receipts (
          seq             INTEGER PRIMARY KEY AUTOINCREMENT,
          id              TEXT NOT NULL UNIQUE,
          request_id      TEXT NOT NULL,
          resource_id     TEXT NOT NULL,
          payment_json    TEXT,
          delivered_at    TEXT NOT NULL,
          backend_status  INTEGER NOT NULL,
          duration_ms     INTEGER,
          protocol        TEXT,
          metadata_json   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_receipts_request_id ON receipts(request_id);
        CREATE INDEX IF NOT EXISTS idx_receipts_delivered_at ON receipts(delivered_at);

        CREATE TABLE IF NOT EXISTS events (
          seq               INTEGER PRIMARY KEY AUTOINCREMENT,
          id                TEXT NOT NULL UNIQUE,
          type              TEXT NOT NULL,
          request_id        TEXT NOT NULL,
          resource_id       TEXT,
          at                TEXT NOT NULL,
          adapter           TEXT,
          payment_provider  TEXT,
          duration_ms       INTEGER,
          status            TEXT,
          data_json         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_request_id ON events(request_id);
        CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);

        CREATE TABLE IF NOT EXISTS payment_attempts (
          seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
          id                  TEXT NOT NULL UNIQUE,
          request_id          TEXT NOT NULL,
          resource_id         TEXT NOT NULL,
          provider             TEXT NOT NULL,
          replay_key          TEXT NOT NULL UNIQUE,
          status              TEXT NOT NULL,
          amount              TEXT NOT NULL,
          currency            TEXT NOT NULL,
          payer               TEXT,
          payee               TEXT,
          external_reference  TEXT,
          rejection_reason    TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payment_attempts_request_id ON payment_attempts(request_id);
        CREATE INDEX IF NOT EXISTS idx_payment_attempts_created_at ON payment_attempts(created_at);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      // Not folded into v1: an existing database keeps its rows, and a receipt
      // written before this column has no authorization to record
      db.exec(`ALTER TABLE receipts ADD COLUMN authorization_json TEXT;`);
    },
  },
  {
    version: 3,
    up(db) {
      // Archive rejected attempts before reclaim overwrites them. replay_key
      // is not unique here: one authorization can be rejected and reclaimed
      // repeatedly.
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_attempt_history (
          seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
          id                  TEXT NOT NULL,
          request_id          TEXT NOT NULL,
          resource_id         TEXT NOT NULL,
          provider            TEXT NOT NULL,
          replay_key          TEXT NOT NULL,
          status              TEXT NOT NULL,
          amount              TEXT NOT NULL,
          currency            TEXT NOT NULL,
          payer               TEXT,
          payee               TEXT,
          external_reference  TEXT,
          rejection_reason    TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          superseded_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payment_attempt_history_replay_key ON payment_attempt_history(replay_key);
        CREATE INDEX IF NOT EXISTS idx_payment_attempt_history_request_id ON payment_attempt_history(request_id);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // Join payment status from the attempt through attempt_id; cache only
      // the derived transaction state for filtering. New columns on existing
      // rows remain NULL, and no journal entries are backfilled.
      db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          seq                        INTEGER PRIMARY KEY AUTOINCREMENT,
          id                         TEXT NOT NULL UNIQUE,
          request_id                 TEXT NOT NULL,
          resource_id                TEXT NOT NULL,
          protocol                   TEXT NOT NULL,
          state                      TEXT NOT NULL,
          provider                   TEXT NOT NULL,
          attempt_id                 TEXT NOT NULL,
          replay_key                 TEXT NOT NULL,
          network                    TEXT,
          asset                      TEXT,
          authorization_json         TEXT,
          reservation_id             TEXT,
          locator_json               TEXT,
          expires_at                 TEXT,
          input_digest               TEXT,
          config_digest              TEXT NOT NULL,
          settling_at                TEXT,
          backend_dispatched_at      TEXT,
          backend_deadline_at        TEXT,
          backend_status             INTEGER,
          backend_error_code         TEXT,
          receipt_id                 TEXT,
          persistence_failures_json  TEXT,
          completed_at               TEXT,
          created_at                 TEXT NOT NULL,
          updated_at                 TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_state_seq ON transactions(state, seq);
        CREATE INDEX IF NOT EXISTS idx_transactions_request_id ON transactions(request_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_replay_key ON transactions(replay_key);

        ALTER TABLE receipts ADD COLUMN transaction_id TEXT;
        ALTER TABLE events ADD COLUMN transaction_id TEXT;
        ALTER TABLE payment_attempts ADD COLUMN transaction_id TEXT;
        ALTER TABLE payment_attempts ADD COLUMN resolution_json TEXT;
        ALTER TABLE payment_attempt_history ADD COLUMN transaction_id TEXT;
        ALTER TABLE payment_attempt_history ADD COLUMN resolution_json TEXT;
        CREATE INDEX IF NOT EXISTS idx_payment_attempt_history_id ON payment_attempt_history(id);
      `);
    },
  },
  {
    version: 5,
    up(db) {
      // Add shared tables for AP2 holds, ACP claims and A2A tasks without
      // changing existing tables. A 2.5.x gateway rejects this database at
      // init() because it requires exactly v4.
      db.exec(`
        CREATE TABLE IF NOT EXISTS authorization_holds (
          reference          TEXT PRIMARY KEY,
          method             TEXT NOT NULL,
          binding_reference  TEXT NOT NULL,
          resource_id        TEXT NOT NULL,
          request_id         TEXT NOT NULL,
          state              TEXT NOT NULL
                             CHECK (state IN ('reserved', 'consumed', 'released', 'uncertain')),
          metadata_json      TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_authorization_holds_binding ON authorization_holds(binding_reference);
        CREATE INDEX IF NOT EXISTS idx_authorization_holds_request_id ON authorization_holds(request_id);
        CREATE INDEX IF NOT EXISTS idx_authorization_holds_state_updated ON authorization_holds(state, updated_at);

        CREATE TABLE IF NOT EXISTS idempotency_keys (
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
        CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

        CREATE TABLE IF NOT EXISTS pending_tasks (
          id                 TEXT PRIMARY KEY,
          protocol           TEXT NOT NULL,
          resource_id        TEXT NOT NULL,
          input_json         TEXT NOT NULL,
          adapter_data_json  TEXT,
          created_at         TEXT NOT NULL,
          expires_at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pending_tasks_expires_at ON pending_tasks(expires_at);

        -- path is NULL when the feature started with nothing to import
        CREATE TABLE IF NOT EXISTS legacy_imports (
          source       TEXT PRIMARY KEY,
          path         TEXT,
          rows         INTEGER NOT NULL,
          imported_at  TEXT NOT NULL
        );
      `);
    },
  },
];

/** Target schema version: the version of the last migration */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Apply pending migrations through `target`, defaulting to {@link SCHEMA_VERSION},
 * with one transaction per migration. At or above the target version, read
 * `PRAGMA user_version` without changing the database.
 */
export function migrate(db: Database.Database, target = SCHEMA_VERSION): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current || migration.version > target) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
}
