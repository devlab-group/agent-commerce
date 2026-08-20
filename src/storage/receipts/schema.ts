/**
 * Explicit migration scheme for the receipt-store SQLite schema.
 *
 * Uses SQLite's built-in `PRAGMA user_version` as the migration marker so a
 * restart against an existing database file re-opens without re-creating or
 * losing data (required negative test: "gateway restart with receipt storage
 * preserved").
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
];

/** Current target schema version — the version of the last migration. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Bring `db` up to {@link SCHEMA_VERSION}. Idempotent: re-opening an existing,
 * already-migrated file is a fast no-op check against `PRAGMA user_version`.
 */
export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
}
