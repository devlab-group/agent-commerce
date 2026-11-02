/**
 * `agent-commerce backup` copies the receipt database and eligible legacy
 * files into a new or empty directory. Legacy files must be configured for
 * enabled AP2 or ACP, exist and have no recorded import.
 *
 * Sources open read-only, without migrations, imports or write locks, so the
 * command can run alongside a live gateway. `VACUUM INTO` creates a consistent
 * snapshot of each file. The command writes `backup.json` last; a directory
 * without it is an incomplete backup.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { type Clock, systemClock } from '../../core';
import { redactedErrorText } from '../../core/errors';
import { hasTable, SCHEMA_VERSION } from '../../storage/receipts/schema';
import { PACKAGE_VERSION } from '../../version';
import { type ConfigLoader, loadConfigDynamic } from '../lib/config-client';
import type { Io } from '../lib/io';
import { formatConfigError } from './validate';

export interface BackupOptions {
  readonly out: string;
  readonly configPath?: string;
  readonly json?: boolean;
}

export interface BackupDeps {
  readonly loadConfig?: ConfigLoader;
  readonly clock?: Clock;
}

/** One copied file in `backup.json` */
export interface BackupFile {
  readonly file: string;
  /** The config key that names the source */
  readonly source: string;
  /** The copy's `PRAGMA user_version` */
  readonly schemaVersion: number;
  readonly sha256: string;
}

/** The `backup.json` manifest */
export interface BackupManifest {
  readonly packageVersion: string;
  readonly createdAt: string;
  readonly files: readonly BackupFile[];
}

// Accept schemas from 2.5's v4 through the current version so operators can
// back up before a startup migration
const OLDEST_SCHEMA = 4;

const LEGACY = [
  { file: 'ap2-replay.sqlite', source: 'authorization.ap2.replay.path', marker: 'ap2-replay' },
  {
    file: 'acp-idempotency.sqlite',
    source: 'protocols.acp.idempotency.path',
    marker: 'acp-idempotency',
  },
] as const;

class BackupError extends Error {}

export async function runBackupCommand(
  options: BackupOptions,
  io: Io,
  deps: BackupDeps = {},
): Promise<number> {
  let config: Awaited<ReturnType<ConfigLoader>>;
  try {
    config = await (deps.loadConfig ?? loadConfigDynamic)(
      options.configPath !== undefined ? { path: options.configPath } : {},
    );
  } catch (error) {
    io.stderr(formatConfigError(error, false, false));
    return 1;
  }

  try {
    const receipts = config.storage.receipts.path;
    if (receipts === ':memory:') throw new BackupError('the receipt database is in memory');
    if (!existsSync(receipts)) {
      throw new BackupError(`the receipt database "${resolve(receipts)}" does not exist`);
    }
    const ap2 = config.authorization?.ap2;
    const acp = config.protocols.acp;
    const legacyPaths: Record<string, string | undefined> = {
      'authorization.ap2.replay.path': ap2?.enabled ? ap2.replay?.path : undefined,
      'protocols.acp.idempotency.path': acp.enabled ? acp.idempotency.path : undefined,
    };

    prepareOut(options.out);
    const files: BackupFile[] = [];
    const imported = await copy(
      receipts,
      options.out,
      'receipts.sqlite',
      'storage.receipts.path',
      files,
    );
    for (const legacy of LEGACY) {
      const path = legacyPaths[legacy.source];
      if (path === undefined || path === ':memory:' || !existsSync(path)) continue;
      // Skip sources the receipt database records as already imported
      if (imported.has(legacy.marker)) continue;
      await copy(path, options.out, legacy.file, legacy.source, files);
    }

    const manifest: BackupManifest = {
      packageVersion: PACKAGE_VERSION,
      createdAt: (deps.clock ?? systemClock).nowIso(),
      files,
    };
    writeFileSync(join(options.out, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });

    if (options.json === true) {
      io.stdout(JSON.stringify({ out: resolve(options.out), ...manifest }, null, 2));
    } else {
      io.stdout(`backup written to ${resolve(options.out)}`);
      for (const file of files) {
        io.stdout(`  ${file.file.padEnd(24)} ${file.source} (schema v${file.schemaVersion})`);
      }
    }
    return 0;
  } catch (error) {
    io.stderr(
      `FAIL  backup: ${error instanceof BackupError ? error.message : redactedErrorText(error)}`,
    );
    return 1;
  }
}

// Create a new destination at 0700, or require an existing one to be empty
function prepareOut(out: string): void {
  if (!existsSync(out)) {
    mkdirSync(out, { mode: 0o700 });
    return;
  }
  if (!statSync(out).isDirectory()) throw new BackupError(`--out "${out}" is not a directory`);
  if (readdirSync(out).length > 0) throw new BackupError(`--out "${out}" is not empty`);
}

// Copy `source` to `out/file`, validate it and record its hash and schema.
// Return any import markers found in the source.
async function copy(
  source: string,
  out: string,
  file: string,
  key: string,
  files: BackupFile[],
): Promise<Set<string>> {
  const target = join(out, file);
  const markers = new Set<string>();
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    if (key === 'storage.receipts.path') {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version < OLDEST_SCHEMA || version > SCHEMA_VERSION) {
        throw new BackupError(
          `the receipt database "${resolve(source)}" is at schema v${version}; this version backs up v${OLDEST_SCHEMA} to v${SCHEMA_VERSION}`,
        );
      }
      if (hasTable(db, 'legacy_imports')) {
        // Count only file imports; a NULL path records a check with no file
        const rows = db
          .prepare('SELECT source FROM legacy_imports WHERE path IS NOT NULL')
          .all() as { source: string }[];
        for (const row of rows) markers.add(row.source);
      }
    }
    // Pre-create the empty target at 0600; VACUUM INTO preserves its mode
    // while writing the copy
    closeSync(openSync(target, 'wx', 0o600));
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }

  const copied = new Database(target, { readonly: true, fileMustExist: true });
  let schemaVersion: number;
  try {
    const integrity = copied.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new BackupError(`${file} failed its integrity check: ${String(integrity)}`);
    }
    schemaVersion = copied.pragma('user_version', { simple: true }) as number;
  } finally {
    copied.close();
  }
  files.push({ file, source: key, schemaVersion, sha256: await sha256(target) });
  return markers;
}

function sha256(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
      .on('error', reject);
  });
}
