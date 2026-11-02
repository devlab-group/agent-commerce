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
import { hasTable } from './schema';

/** Deprecated store files to import. Experimental: through 2.x only */
export interface LegacyStoreOptions {
  /** Deprecated `authorization.ap2.replay.path` */
  readonly ap2Replay?: string;
  /** Deprecated `protocols.acp.idempotency.path` */
  readonly acpIdempotency?: string;
  /**
   * Enabled features whose missing legacy history must be checked. Without a
   * recorded import or prior check, `init()` rejects an unset key or missing
   * file when the receipt database shows past use. `:memory:` explicitly
   * declares that no legacy file was retained. A passed check with no file
   * is recorded so later starts can omit the key.
   */
  readonly enabled?: { readonly ap2?: boolean; readonly acp?: boolean };
}

/** A deprecated store file's name in `legacy_imports` */
export type LegacySource = 'ap2-replay' | 'acp-idempotency';

interface Source {
  readonly name: LegacySource;
  readonly option: 'ap2Replay' | 'acpIdempotency';
  readonly feature: 'ap2' | 'acp';
  readonly key: string;
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

const SOURCES: readonly Source[] = [
  {
    name: 'ap2-replay',
    option: 'ap2Replay',
    feature: 'ap2',
    key: 'authorization.ap2.replay.path',
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

function selectMarker(db: Database.Database, source: LegacySource) {
  return db
    .prepare<[string], { path: string | null }>('SELECT path FROM legacy_imports WHERE source = ?')
    .get(source);
}

const usedBefore = (db: Database.Database, source: Source): boolean =>
  db.prepare(source.usedSql).get() !== undefined;

/**
 * Finds sources with past-use evidence and no recorded import or prior
 * check. If the feature is enabled, `init()` refuses an unset key or a missing
 * source file until its history is imported or its loss explicitly accepted.
 */
export function missingLegacyImports(db: Database.Database): LegacySource[] {
  // Schemas below v5 have no legacy_imports table
  const recorded = hasTable(db, 'legacy_imports');
  return SOURCES.filter(
    (source) =>
      !(recorded && selectMarker(db, source.name) !== undefined) && usedBefore(db, source),
  ).map((source) => source.name);
}

/**
 * Reads {@link missingLegacyImports} from an existing file opened read-only.
 * Returns undefined if opening the file or querying its tables fails.
 */
export function readMissingLegacyImports(path: string): LegacySource[] | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    return missingLegacyImports(db);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/**
 * Import sources with no recorded import and retain acquired file locks.
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
  // Record a passed check with no file as NULL; a later file import replaces it
  const recordMarker = db.prepare(
    `INSERT INTO legacy_imports (source, path, rows, imported_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET
       path = excluded.path, rows = excluded.rows, imported_at = excluded.imported_at`,
  );
  const locks: Database.Database[] = [];
  const release = () => {
    for (const lock of locks.splice(0)) lock.close();
  };

  try {
    for (const source of SOURCES) {
      const given = options[source.option];
      const marker = selectMarker(db, source.name);
      const importedPath = marker?.path ?? undefined;
      const path = given !== undefined && given !== ':memory:' ? resolve(given) : undefined;

      // Locking the receipt database itself would block every write to it
      if (path !== undefined && receiptsPath !== ':memory:' && path === resolve(receiptsPath)) {
        throw storageError(`${source.key} names the receipt database "${path}"`, {
          key: source.key,
          path,
        });
      }
      if (path !== undefined && importedPath !== undefined && importedPath !== path) {
        throw storageError(
          `${source.key} names "${path}", but "${importedPath}" was imported from it already. ` +
            `Point ${source.key} back at the imported file, or remove the key.`,
          { key: source.key, path, importedPath },
        );
      }
      if (path === undefined || !existsSync(path)) {
        if (marker === undefined && options.enabled?.[source.feature] === true) {
          // A 2.5 in-memory store retained no history across restarts
          if (given !== ':memory:' && usedBefore(db, source)) {
            throw forgottenKey(source, path);
          }
          recordMarker.run(source.name, null, 0, clock.nowIso());
        }
        if (given !== undefined) {
          logger.info(
            { key: source.key, path: path ?? given },
            'deprecated store has no file to import; the key can be removed',
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
        if (importedPath !== undefined && cantOpen) {
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
      if (importedPath !== undefined) continue;

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
        recordMarker.run(source.name, path, imported.rows, clock.nowIso());
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

// Losing AP2 replay records could allow a consumed mandate to be reused
function forgottenKey(source: Source, path: string | undefined): CommerceError {
  return storageError(
    `${source.feature.toUpperCase()} ran on this receipt database before, but ${source.key} ` +
      `${path === undefined ? 'is not set' : `names a missing file "${path}"`}, so its records would be lost. ` +
      `Set ${source.key} to the file the previous version used to import them, or to an empty file to accept the loss.`,
    { key: source.key, ...(path !== undefined ? { path } : {}) },
  );
}
