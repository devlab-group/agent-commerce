/**
 * Opening a SQLite file safely.
 *
 * One definition, because every rule below was learned once and must not be
 * re-learned per store: the file is pre-created at 0600 before SQLite can
 * create it at `0666 & ~umask`, the WAL sidecars are narrowed after WAL is
 * enabled (they do not exist until then), and an existing but unwritable file
 * fails at startup instead of on the first write.
 *
 * Callers own their schema. This function opens and hardens; it migrates
 * nothing.
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
import { CommerceError, type Logger } from '../core/index.js';

export interface OpenSqliteOptions {
  /** File path, or ':memory:' for tests. Parent directory is created if missing. */
  readonly path: string;
  /** Names the database in operator-facing errors, e.g. "Receipt database". */
  readonly label: string;
  readonly logger: Logger;
}

export function openSqliteDatabase(options: OpenSqliteOptions): Database.Database {
  const { path, label, logger } = options;
  const isFileBacked = path !== ':memory:';

  if (isFileBacked) {
    const dir = dirname(path);
    if (dir !== '' && dir !== '.' && !existsSync(dir)) {
      // 0700 on directories we create ourselves. An existing directory is the
      // operator's to own and is deliberately left alone.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  // Fail at startup, not on the first write. `new Database(path)` happily opens
  // a file the process cannot write, and SQLite only says "attempt to write a
  // readonly database" once a write is attempted - which on a paid resource is
  // *after* the payment attempt reservation, surfacing as an opaque
  // STORAGE_ERROR per request. Readiness does catch it (503), but the operator
  // is left guessing. This is not hypothetical: switching the demo containers
  // to a non-root user left an existing named volume root-owned, and that is
  // exactly how it presented.
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

  // Create the file ourselves, at 0600, *before* SQLite can create it at
  // `0666 & ~umask`. The chmod below only narrows the mode after the fact: a
  // local co-tenant who opens the file inside that window keeps a readable
  // descriptor across the chmod and reads everything written afterwards.
  // SQLite copies the main file's mode onto the -wal/-shm sidecars, so this one
  // call covers all three. `mode` applies on creation only, so an existing file
  // is untouched here and left to the chmod.
  if (isFileBacked) {
    try {
      closeSync(openSync(path, 'a', 0o600));
    } catch {
      // Deliberately silent: whatever stopped us (unwritable directory, exotic
      // filesystem) is about to be reported by `new Database` with a better
      // message, or is harmless and covered by the chmod below.
    }
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (isFileBacked) restrictDatabasePermissions(path, label, logger);
  return db;
}

/**
 * Narrow the database and its WAL sidecars to owner-only.
 *
 * `new Database(path)` opens with `0666 & ~umask`, so on a standard host the
 * `.sqlite`, `-wal` and `-shm` files landed at 0644 - any other local user
 * could read the whole commerce ledger: payer and payee addresses, amounts,
 * settlement transaction hashes, replay keys and the entire event stream. No
 * key material (the gateway is non-custodial and `redact.ts` is recursive), but
 * business metadata all the same.
 *
 * Called *after* `journal_mode = WAL`, because the sidecars do not exist until
 * then. Belt-and-braces since the main file is pre-created at 0600 above: this
 * still tightens a database that already existed with a looser mode.
 * Best-effort by design: a filesystem without POSIX modes must not stop the
 * gateway from starting, so a failure warns rather than throws.
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
