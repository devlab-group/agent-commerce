import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/core/index.js';
import { createSqliteReceiptStore } from '../../../src/storage/receipts/index.js';
import { migrate } from '../../../src/storage/receipts/schema.js';
import { makeReceipt } from './helpers.js';

interface CapturedWarning {
  readonly obj: Record<string, unknown>;
  readonly msg: string | undefined;
}

/** Captures warn() calls so a test can assert the raw detail went to the logger, not the caller. */
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

  it('initialises a fresh schema on a brand-new file', async () => {
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

  it('supports:memory: for tests', async () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
    await store.saveReceipt(makeReceipt({ id: 'mem_1' }));
    expect(await store.getReceipt('mem_1')).toBeDefined();
    await store.close();
  });

  it('reports FAIL health when the on-disk schema version is ahead of what this build knows', async () => {
    const path = join(dir, 'stale.db');
    // Simulate a file already migrated by a *newer* build: real tables exist
    // (so statement preparation still succeeds) but user_version is bumped
    // past what this build's migrations produce.
    const raw = new Database(path);
    migrate(raw);
    raw.pragma('user_version = 99');
    raw.close();

    const store = createSqliteReceiptStore({ path });
    const health = await store.health();
    expect(health.status).toBe('fail');
    // The detail is a fixed vocabulary token, never a sentence built from
    // caught internals.
    expect(health.detail).toBe('store-schema-mismatch');
    await store.close();
  });

  it('reports a fixed-vocabulary detail (never the raw error message) when the store is unwritable, and logs the raw message', async () => {
    const path = join(dir, 'readonly.db');
    const logger = createCapturingLogger();
    const store = createSqliteReceiptStore({ path, logger });
    await store.init();

    // Simulate permissions changing under a live connection (e.g. a host
    // mount going read-only) rather than re-opening, since better-sqlite3
    // refuses to open a brand-new connection against a non-writable file at
    // all — that path never reaches health()'s catch block.
    chmodSync(path, 0o444);

    const health = await store.health();

    expect(health.status).toBe('fail');
    expect(health.detail).toBe('store-unwritable');
    // The absolute path / raw OS error text must never appear in the detail
    // returned to an unauthenticated caller.
    expect(health.detail).not.toContain(path);
    expect(health.detail).not.toMatch(/EACCES|permission denied/i);
    //...but it must not be silently lost either — it goes to the logger.
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(String(logger.warnings[0]?.obj['err'])).toMatch(/EACCES|permission denied/i);

    // Restore write access before closing: better-sqlite3's WAL checkpoint
    // on close needs it, and that is not what this test is about.
    chmodSync(path, 0o644);
    await store.close();
  });

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
    // `new Database(path)` opens a file it cannot write; SQLite only complains
    // on the first write, which on a paid resource lands after the payment
    // attempt reservation and surfaces as an opaque STORAGE_ERROR per request.
    // Observed for real: switching the demo containers to a non-root user left
    // an existing named volume root-owned.
    const dir = mkdtempSync(join(tmpdir(), 'oac-ro-'));
    const dbPath = join(dir, 'receipts.sqlite');
    createSqliteReceiptStore({ path: dbPath }).close();
    chmodSync(dbPath, 0o400);

    expect(() => createSqliteReceiptStore({ path: dbPath })).toThrowError(/not writable/);

    chmodSync(dbPath, 0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(posix)('control: a writable database still opens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-rw-'));
    const dbPath = join(dir, 'receipts.sqlite');
    const store = createSqliteReceiptStore({ path: dbPath });
    expect(() => store.saveReceipt(makeReceipt())).not.toThrow();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('file permissions', () => {
  // The ledger holds payer/payee addresses, amounts, settlement transaction
  // hashes and replay keys. `new Database(path)` opens with `0666 & ~umask`,
  // which on a normal host is 0644 — readable by every other local user.
  // Skipped on platforms without POSIX modes rather than asserting nonsense.
  const posix = process.platform !== 'win32';

  it.runIf(posix)('creates the database and its WAL sidecars owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-perm-'));
    const dbPath = join(dir, 'nested', 'receipts.sqlite');
    const store = createSqliteReceiptStore({ path: dbPath });
    store.saveReceipt(makeReceipt());

    const mode = (p: string): number => statSync(p).mode & 0o777;
    expect(mode(join(dir, 'nested'))).toBe(0o700);
    const files = readdirSync(join(dir, 'nested'));
    // The -wal and -shm sidecars only exist once WAL mode is on; they carry
    // the same rows as the database and must not be looser than it.
    expect(files).toContain('receipts.sqlite');
    for (const file of files) {
      expect(mode(join(dir, 'nested', file))).toBe(0o600);
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
