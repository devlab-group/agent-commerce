/**
 * The steady-state mode (0600 on the database and both sidecars) is asserted
 * in persistence.test.ts. It cannot prove *ordering*, though: a chmod after
 * `new Database` produces the same end state as pre-creating the file, while
 * leaving a window in which a local co-tenant can open the ledger read-only
 * and keep that descriptor across the chmod. Only a reading taken at the
 * moment SQLite first opens the file distinguishes the two, so this file wraps
 * the driver's constructor to take one.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteReceiptStore } from '../../../src/storage/receipts/index.js';

const observed = vi.hoisted(() => ({ modes: [] as (number | null)[] }));

vi.mock('better-sqlite3', async (importOriginal) => {
  const actual = (await importOriginal()) as { default: new (...args: never[]) => object };
  return {
    default: new Proxy(actual.default, {
      construct(target, args) {
        const path = args[0];
        observed.modes.push(
          typeof path === 'string' && path !== ':memory:' && existsSync(path)
            ? statSync(path).mode & 0o777
            : null,
        );
        return Reflect.construct(target, args);
      },
    }),
  };
});

describe('the ledger is never world-readable, not even briefly', () => {
  // Skipped on platforms without POSIX modes rather than asserting nonsense.
  const posix = process.platform !== 'win32';

  beforeEach(() => {
    observed.modes.length = 0;
  });

  it.runIf(posix)('creates the database file at 0600 before SQLite opens it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-precreate-'));
    const dbPath = join(dir, 'receipts.sqlite');

    const store = createSqliteReceiptStore({ path: dbPath });
    store.close();

    // null would mean the file did not exist yet — i.e. SQLite created it
    // itself, at `0666 & ~umask`.
    expect(observed.modes).toEqual([0o600]);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(posix)('reopens an existing database without disturbing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-reopen-'));
    const dbPath = join(dir, 'receipts.sqlite');
    createSqliteReceiptStore({ path: dbPath }).close();

    const store = createSqliteReceiptStore({ path: dbPath });
    store.close();

    expect(observed.modes).toEqual([0o600, 0o600]);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not pre-create anything for :memory:', () => {
    const store = createSqliteReceiptStore({ path: ':memory:' });
    store.close();
    expect(existsSync(':memory:')).toBe(false);
  });
});
