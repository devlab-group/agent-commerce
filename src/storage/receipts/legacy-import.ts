/**
 * Import deprecated AP2 replay and ACP idempotency files into the receipt
 * database once per source. Acquire write locks before copying and keep them
 * until the store closes, releasing them if initialization fails.
 *
 * A held lock blocks other writers with `SQLITE_BUSY`. Readers can continue
 * in WAL mode; other journal modes block reads too. The write transaction is
 * never committed, so closing it releases the lock without changing legacy rows.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { type Clock, CommerceError, type Logger, toCommerceError } from '../../core';

/** Deprecated store files to import. Experimental: through 2.x only */
export interface LegacyStoreOptions {
  /** Deprecated `authorization.ap2.replay.path` */
  readonly ap2Replay?: string;
  /** Deprecated `protocols.acp.idempotency.path` */
  readonly acpIdempotency?: string;
  /**
   * Enabled features to check for missing legacy records. With no import or
   * feature rows recorded, `init()` rejects a missing file or path when the
   * receipt database shows past use. The legacy file may have been forgotten.
   */
  readonly enabled?: { readonly ap2?: boolean; readonly acp?: boolean };
}

interface Source {
  readonly name: 'ap2-replay' | 'acp-idempotency';
  readonly option: 'ap2Replay' | 'acpIdempotency';
  readonly feature: 'ap2' | 'acp';
  readonly key: string;
  // Rows the store already holds for this feature
  readonly storedSql: string;
  // Evidence of past use in the receipt database
  readonly usedSql: string;
  // Read through the locked source connection and return a destination writer
  read(file: Database.Database, logger: Logger): Imported;
}

interface Imported {
  readonly rows: number;
  write(db: Database.Database): void;
}

const NOTHING: Imported = { rows: 0, write: () => {} };

function hasTable(file: Database.Database, name: string): boolean {
  return (
    file.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

const SOURCES: readonly Source[] = [
  {
    name: 'ap2-replay',
    option: 'ap2Replay',
    feature: 'ap2',
    key: 'authorization.ap2.replay.path',
    storedSql: "SELECT 1 FROM authorization_holds WHERE method = 'ap2' LIMIT 1",
    usedSql: `SELECT 1 FROM receipts WHERE authorization_json IS NOT NULL
               UNION ALL SELECT 1 FROM transactions WHERE authorization_json IS NOT NULL LIMIT 1`,
    read(file) {
      if (!hasTable(file, 'ap2_authorizations')) return NOTHING;
      const rows = file
        .prepare(
          `SELECT reference, checkout_jti, mandate_issuer, checkout_issuer, resource_id,
                  request_id, state, created_at, updated_at
             FROM ap2_authorizations`,
        )
        .all() as Record<string, string>[];
      return {
        rows: rows.length,
        write(db) {
          // A reference already in the store keeps its state unless it is
          // released, so a mandate either side blocks stays blocked
          const insert = db.prepare(
            `INSERT INTO authorization_holds
               (reference, method, binding_reference, resource_id, request_id, state,
                metadata_json, created_at, updated_at)
             VALUES (@reference, 'ap2', @checkout_jti, @resource_id, @request_id, @state,
                     @metadata_json, @created_at, @updated_at)
             ON CONFLICT (reference) DO UPDATE SET
               binding_reference = excluded.binding_reference, resource_id = excluded.resource_id,
               request_id = excluded.request_id, state = excluded.state,
               metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
             WHERE authorization_holds.state = 'released'`,
          );
          for (const row of rows) {
            insert.run({
              ...row,
              metadata_json: JSON.stringify({
                mandateIssuer: row.mandate_issuer,
                checkoutIssuer: row.checkout_issuer,
              }),
            });
          }
        },
      };
    },
  },
  {
    name: 'acp-idempotency',
    option: 'acpIdempotency',
    feature: 'acp',
    key: 'protocols.acp.idempotency.path',
    storedSql: 'SELECT 1 FROM idempotency_keys LIMIT 1',
    usedSql: "SELECT 1 FROM events WHERE adapter = 'acp' LIMIT 1",
    read(file, logger) {
      if (!hasTable(file, 'acp_idempotency')) return NOTHING;
      // v1 used bearer-token digests instead of deployment URLs. Skip those
      // rows, matching the 2.5 store's migration behavior.
      if ((file.pragma('user_version', { simple: true }) as number) < 2) {
        const { count } = file
          .prepare("SELECT COUNT(*) AS count FROM acp_idempotency WHERE state != 'completed'")
          .get() as { count: number };
        if (count > 0) {
          logger.warn(
            { unresolved: count },
            'acp idempotency: the schema v1 file holds claims keyed by an old bearer-token digest, which are not imported; ' +
              'reconcile these operations against the merchant before trusting a retry',
          );
        }
        return NOTHING;
      }
      const rows = file
        .prepare(
          `SELECT deployment, endpoint, idempotency_key, fingerprint, state, status, body_json,
                  created_at, expires_at
             FROM acp_idempotency`,
        )
        .all();
      return {
        rows: rows.length,
        write(db) {
          // Leave `in_flight` rows for `recoverIdempotencyKeys` to handle
          const insert = db.prepare(
            `INSERT INTO idempotency_keys
               (deployment, endpoint, idempotency_key, fingerprint, state, status, body_json,
                created_at, expires_at)
             VALUES (@deployment, @endpoint, @idempotency_key, @fingerprint, @state, @status,
                     @body_json, @created_at, @expires_at)
             ON CONFLICT DO NOTHING`,
          );
          for (const row of rows) insert.run(row);
        },
      };
    },
  },
];

function storageError(message: string, details: Record<string, unknown>, cause?: unknown) {
  return new CommerceError('STORAGE_ERROR', message, { details, cause });
}

/**
 * Import sources with no recorded marker and retain acquired file locks.
 * Import or lock failures, changed source paths, the receipt database's path
 * and missing legacy records can cause `STORAGE_ERROR`. Release acquired locks
 * on failure; earlier source imports remain committed. Return a function to
 * release the locks after successful initialization.
 */
export function importLegacyStores(
  db: Database.Database,
  receiptsPath: string,
  options: LegacyStoreOptions,
  clock: Clock,
  logger: Logger,
): () => void {
  const selectMarker = db.prepare<[string], { path: string }>(
    'SELECT path FROM legacy_imports WHERE source = ?',
  );
  const insertMarker = db.prepare(
    'INSERT INTO legacy_imports (source, path, rows, imported_at) VALUES (?, ?, ?, ?)',
  );
  const locks: Database.Database[] = [];
  const release = () => {
    for (const lock of locks.splice(0)) lock.close();
  };

  try {
    for (const source of SOURCES) {
      const given = options[source.option];
      const marker = selectMarker.get(source.name);
      const path = given !== undefined && given !== ':memory:' ? resolve(given) : undefined;

      // Locking the receipt database itself would block every write to it
      if (path !== undefined && receiptsPath !== ':memory:' && path === resolve(receiptsPath)) {
        throw storageError(`${source.key} names the receipt database "${path}"`, {
          key: source.key,
          path,
        });
      }
      if (path !== undefined && marker !== undefined && marker.path !== path) {
        throw storageError(
          `${source.key} names "${path}", but "${marker.path}" was imported from it already. ` +
            `Point ${source.key} back at the imported file, or remove the key.`,
          { key: source.key, path, importedPath: marker.path },
        );
      }
      if (path === undefined || !existsSync(path)) {
        if (marker === undefined) guardForgottenKey(db, source, options, path);
        if (path !== undefined) {
          logger.info(
            { key: source.key, path },
            'deprecated store file is absent; nothing to import, and the key can be removed',
          );
        }
        continue;
      }

      let file: Database.Database | undefined;
      try {
        file = new Database(path, { fileMustExist: true });
        file.exec('BEGIN EXCLUSIVE');
      } catch (cause) {
        file?.close();
        const cantOpen = (cause as { code?: unknown }).code === 'SQLITE_CANTOPEN';
        // A recorded import permits SQLITE_CANTOPEN here; warn and continue
        if (marker !== undefined && cantOpen) {
          logger.warn(
            { key: source.key, path },
            'deprecated store file cannot be opened to lock it; its rows are already imported',
          );
          continue;
        }
        throw storageError(
          cantOpen
            ? `${source.key} "${path}" cannot be opened to import it, as on a read-only mount. ` +
                'Make its directory writable for the first start of this version, or copy the file somewhere writable and point the key at the copy.'
            : `${source.key} "${path}" cannot be locked for import: ${cause instanceof Error ? cause.message : String(cause)}`,
          { key: source.key, path },
          cause,
        );
      }
      locks.push(file);
      if (marker !== undefined) continue;

      let imported: Imported;
      try {
        imported = source.read(file, logger);
      } catch (cause) {
        throw storageError(
          `${source.key} "${path}" cannot be read for import: ${cause instanceof Error ? cause.message : String(cause)}`,
          { key: source.key, path },
          cause,
        );
      }
      db.transaction(() => {
        imported.write(db);
        insertMarker.run(source.name, path, imported.rows, clock.nowIso());
      })();
      logger.info(
        { key: source.key, path, rows: imported.rows },
        'imported deprecated store file; it stays locked against writes while this gateway runs',
      );
    }
  } catch (err) {
    release();
    throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to import deprecated store files');
  }
  return release;
}

// Refuse startup when an enabled feature's replay history appears missing;
// losing AP2 replay records could allow a consumed mandate to be reused
function guardForgottenKey(
  db: Database.Database,
  source: Source,
  options: LegacyStoreOptions,
  path: string | undefined,
): void {
  if (options.enabled?.[source.feature] !== true) return;
  if (db.prepare(source.storedSql).get() !== undefined) return;
  if (db.prepare(source.usedSql).get() === undefined) return;
  throw storageError(
    `${source.feature.toUpperCase()} ran on this receipt database before, but ${source.key} ` +
      `${path === undefined ? 'is not set' : `names a missing file "${path}"`}, so its records would be lost. ` +
      `Set ${source.key} to the file the previous version used to import them, or to an empty file to accept the loss.`,
    { key: source.key, ...(path !== undefined ? { path } : {}) },
  );
}
