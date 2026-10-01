/**
 * Opens a SQLite file with owner-only permissions. Every store that keeps a
 * SQLite file opens it here, so the hardening below exists once: the file is
 * pre-created at 0600, the WAL sidecars are narrowed once WAL creates them, and
 * an existing but unwritable file fails at startup.
 *
 * Callers own their schema; this function migrates nothing.
 */
import {
  accessSync,
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { CommerceError, type Logger } from '../core';

export interface OpenSqliteOptions {
  /** File path, or ':memory:' for tests. Parent directory is created if missing */
  readonly path: string;
  /** Names the database in operator-facing errors, e.g. "Receipt database" */
  readonly label: string;
  readonly logger: Logger;
}

export function openSqliteDatabase(options: OpenSqliteOptions): Database.Database {
  const { path, label, logger } = options;
  const isFileBacked = path !== ':memory:';

  if (isFileBacked) {
    // 0700 on a directory this creates. A recursive mkdir leaves an existing
    // one, the operator's, with its mode.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  // Check write access at startup. SQLite can open a read-only database and
  // report the problem only when the first write is attempted.
  if (isFileBacked && existsSync(path)) {
    try {
      accessSync(path, fsConstants.W_OK);
    } catch {
      throw new CommerceError(
        'STORAGE_ERROR',
        `${label} "${path}" exists but is not writable by this process (uid ${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}). If this is a container that recently changed user, an existing volume may still be owned by the previous one - recreate it (docker compose down -v) or fix its ownership.`,
        { details: { path } },
      );
    }
  }

  // Create the file at 0600 before SQLite creates it at 0644 (less the umask).
  // A chmod afterwards is too late: a local user who opens the file in between
  // keeps a readable descriptor across the chmod. SQLite copies the main file's
  // mode onto the -wal/-shm sidecars, so this covers all three. `mode` applies
  // on creation only; an existing file is left to the chmod below.
  if (isFileBacked) {
    try {
      closeSync(openSync(path, 'a', 0o600));
    } catch {
      // Silent on purpose: `new Database` reports the same cause with a better
      // message, or the failure is harmless and the chmod below covers it
    }
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (isFileBacked) restrictDatabasePermissions(path, label, logger);
  return db;
}

/**
 * Narrows the database and its WAL sidecars to owner-only. The receipt ledger
 * holds no key material, but it does hold payer and payee addresses, amounts,
 * settlement hashes, replay keys and the commerce event log.
 *
 * Runs after `journal_mode = WAL`, which creates the sidecars, and also
 * tightens a database that already existed with a looser mode. A failure only
 * warns: a filesystem without POSIX modes must not stop the gateway starting.
 */
function restrictDatabasePermissions(path: string, label: string, logger: Logger): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      logger.warn(
        { file, label, error: code ?? 'unknown' },
        'could not restrict database permissions to owner-only',
      );
    }
  }
}
