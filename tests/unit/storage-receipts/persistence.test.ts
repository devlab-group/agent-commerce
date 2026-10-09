import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/core';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { migrate } from '../../../src/storage/receipts/schema';
import { makeReceipt } from './helpers';

interface CapturedWarning {
  readonly obj: Record<string, unknown>;
  readonly msg: string | undefined;
}

// Captures warn() calls so a test can assert the raw detail went to the logger, not the caller
function createCapturingLogger(): Logger & { readonly warnings: readonly CapturedWarning[] } {
  const warnings: CapturedWarning[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (obj, msg) => {
      warnings.push({ obj, msg });
    },
    error: () => {},
    child: () => logger,
  };
  return Object.assign(logger, { warnings });
}

describe('schema lifecycle', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('initializes a fresh schema on a brand-new file', async () => {
    const path = join(dir, 'receipts.db');
    expect(existsSync(path)).toBe(false);

    const store = createSqliteReceiptStore({ path });
    await store.init();

    expect(existsSync(path)).toBe(true);
    const health = await store.health();
    expect(health.status).toBe('pass');
    await store.close();
  });

  it('creates a missing parent directory for a file path', async () => {
    const nested = join(dir, 'nested', 'deeper', 'receipts.db');
    const store = createSqliteReceiptStore({ path: nested });
    await store.init();
    expect(existsSync(nested)).toBe(true);
    await store.close();
  });

  it('preserves data across a restart against the same file (gateway restart)', async () => {
    const path = join(dir, 'receipts.db');

    const first = createSqliteReceiptStore({ path });
    await first.init();
    await first.saveReceipt(makeReceipt({ id: 'r_restart', requestId: 'req_restart' }));
    await first.close();

    const second = createSqliteReceiptStore({ path });
    await second.init();
    const receipt = await second.getReceipt('r_restart');
    expect(receipt).toBeDefined();
    expect(receipt?.requestId).toBe('req_restart');
    await second.close();
  });

  it('reads a receipt written before the authorization column existed', async () => {
    // Build a v1 file: the current schema minus the column migration 2 adds
    const path = join(dir, 'receipts.db');
    const v1 = new Database(path);
    migrate(v1);
    v1.exec('ALTER TABLE receipts DROP COLUMN authorization_json');
    v1.pragma('user_version = 1');
    v1.prepare(
      `INSERT INTO receipts (id, request_id, resource_id, delivered_at, backend_status)
       VALUES ('r_legacy', 'req_legacy', 'resource.report', '2026-01-01T00:00:00.000Z', 200)`,
    ).run();
    v1.close();

    const store = createSqliteReceiptStore({ path });
    await store.init();
    const fetched = await store.getReceipt('r_legacy');
    expect(fetched?.requestId).toBe('req_legacy');
    expect(fetched?.authorization).toBeUndefined();
    expect((await store.health()).status).toBe('pass');
    await store.close();
  });

  it('supports:memory: for tests', async () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
    await store.saveReceipt(makeReceipt({ id: 'mem_1' }));
    expect(await store.getReceipt('mem_1')).toBeDefined();
    await store.close();
  });

  it('reports FAIL health when the on-disk schema version is ahead of what this build knows', async () => {
    const path = join(dir, 'stale.db');
    // A file migrated by a newer build: the tables exist, so statements still
    // prepare, but user_version is past this build's last migration
    const raw = new Database(path);
    migrate(raw);
    raw.pragma('user_version = 99');
    raw.close();

    const store = createSqliteReceiptStore({ path });
    const health = await store.health();
    expect(health.status).toBe('fail');
    // A fixed vocabulary token, never text built from a caught error
    expect(health.detail).toBe('store-schema-mismatch');
    // Startup awaits init(), so the gateway refuses to run on this file
    await expect(store.init()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await store.close();
  });

  // chmod does not stop root (or Windows) from writing, so the store stays
  // writable there; the startup checks below skip under the same condition
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'reports a fixed-vocabulary detail (never the raw error message) when the store is unwritable, and logs the raw message',
    async () => {
      const path = join(dir, 'readonly.db');
      const logger = createCapturingLogger();
      const store = createSqliteReceiptStore({ path, logger });
      await store.init();

      // Permissions change under a live connection (a host mount going
      // read-only, say). Re-opening would not reach health(): opening a store
      // over an unwritable file already throws in openSqliteDatabase.
      chmodSync(path, 0o444);

      const health = await store.health();

      expect(health.status).toBe('fail');
      expect(health.detail).toBe('store-unwritable');
      // Neither the absolute path nor the raw OS error reaches the detail
      expect(health.detail).not.toContain(path);
      expect(health.detail).not.toMatch(/EACCES|permission denied/i);
      // The raw error goes to the logger instead
      expect(logger.warnings.length).toBeGreaterThan(0);
      expect(String(logger.warnings[0]?.obj['err'])).toMatch(/EACCES|permission denied/i);

      // The WAL checkpoint on close needs write access
      chmodSync(path, 0o644);
      await store.close();
    },
  );

  it('close() is idempotent', async () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('health() reports FAIL after close()', async () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
    await store.close();
    const health = await store.health();
    expect(health.status).toBe('fail');
  });

  it('exposes a storage descriptor', async () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    expect(store.descriptor.kind).toBe('storage');
    expect(store.descriptor.name).toBe('sqlite-receipt-store');
    expect(store.descriptor.status).toBe('stable');
    await store.close();
  });
});

describe('an unwritable database fails at startup, not on the first payment', () => {
  const posix = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.runIf(posix)('refuses to construct a store over a read-only database file', () => {
    // Without the startup check every paid request fails its reservation with
    // STORAGE_ERROR instead (see openSqliteDatabase)
    const dir = mkdtempSync(join(tmpdir(), 'oac-ro-'));
    const dbPath = join(dir, 'receipts.sqlite');
    createSqliteReceiptStore({ path: dbPath }).close();
    chmodSync(dbPath, 0o400);

    expect(() => createSqliteReceiptStore({ path: dbPath })).toThrowError(/not writable/);

    chmodSync(dbPath, 0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(posix)('control: a writable database still opens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-rw-'));
    const dbPath = join(dir, 'receipts.sqlite');
    createSqliteReceiptStore({ path: dbPath }).close();

    const store = createSqliteReceiptStore({ path: dbPath });
    await store.saveReceipt(makeReceipt({ id: 'r_writable' }));
    expect((await store.getReceipt('r_writable'))?.id).toBe('r_writable');
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('file permissions', () => {
  // SQLite would create these at 0644 (less the umask), readable by every
  // other local user. Skipped on platforms without POSIX modes.
  const posix = process.platform !== 'win32';

  it.runIf(posix)('creates the database and its WAL sidecars owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-perm-'));
    const dbPath = join(dir, 'nested', 'receipts.sqlite');
    const store = createSqliteReceiptStore({ path: dbPath });
    store.saveReceipt(makeReceipt());

    const mode = (p: string): number => statSync(p).mode & 0o777;
    expect(mode(join(dir, 'nested'))).toBe(0o700);
    const files = readdirSync(join(dir, 'nested'));
    // The -wal and -shm sidecars carry the same rows as the database
    expect(files.sort()).toEqual(['receipts.sqlite', 'receipts.sqlite-shm', 'receipts.sqlite-wal']);
    for (const file of files) {
      expect(mode(join(dir, 'nested', file))).toBe(0o600);
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(posix)(
    'narrows an existing world-readable database and its sidecars to owner-only',
    () => {
      // A ledger left by an older build, or copied in by hand, may be 0644. The
      // pre-create step does not change the mode of a file that already exists.
      const dir = mkdtempSync(join(tmpdir(), 'oac-narrow-'));
      const dbPath = join(dir, 'receipts.sqlite');
      const legacy = new Database(dbPath);
      migrate(legacy);
      legacy.close();
      chmodSync(dbPath, 0o644);

      const store = createSqliteReceiptStore({ path: dbPath });
      store.saveReceipt(makeReceipt());

      const files = readdirSync(dir).sort();
      expect(files).toEqual(['receipts.sqlite', 'receipts.sqlite-shm', 'receipts.sqlite-wal']);
      for (const file of files) {
        expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
      }
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
