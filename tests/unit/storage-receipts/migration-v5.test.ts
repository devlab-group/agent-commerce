// Test schema v5 upgrades using a fixed 2.5.0 (schema v4) SQL fixture
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { dumpTables } from '../../fixtures/sqlite-dump';
import { createFakeClock, createFakeIds } from './helpers';

const FIXTURE = readFileSync(new URL('./fixtures/receipts-v4.sql', import.meta.url), 'utf8');
const NEW_TABLES = ['authorization_holds', 'idempotency_keys', 'legacy_imports', 'pending_tasks'];

const schemaOf = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return {
      version: db.pragma('user_version', { simple: true }) as number,
      sql: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(),
    };
  } finally {
    db.close();
  }
};

describe('schema v5 migration', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-v5-'));
    path = join(dir, 'receipts.sqlite');
    const v4 = new Database(path);
    v4.exec(FIXTURE);
    v4.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const open = () =>
    createSqliteReceiptStore({ path, clock: createFakeClock(), ids: createFakeIds() });

  it('upgrades a 2.5.0 file and leaves every existing row unchanged', async () => {
    const before = dumpTables(path);
    expect(schemaOf(path).version).toBe(4);
    expect(before['transactions']).toHaveLength(5);

    const store = open();
    try {
      await store.init();
    } finally {
      await store.close();
    }

    const after = dumpTables(path);
    expect(schemaOf(path).version).toBe(5);
    for (const table of NEW_TABLES) expect(after[table]).toEqual([]);
    const existing = Object.fromEntries(
      Object.entries(after).filter(([table]) => !NEW_TABLES.includes(table)),
    );
    expect(existing).toStrictEqual(before);
  });

  it('reads the 2.5.0 journal back through the store', async () => {
    const store = open();
    try {
      await store.init();
      expect(await store.getTransaction?.('txn_v4_delivered')).toMatchObject({
        state: 'delivered',
        authorization: { method: 'ap2', reference: 'sha256:mandate_v4', hold: 'consumed' },
        receiptId: 'receipt_v4_delivered',
      });
      expect(await store.getTransaction?.('txn_v4_uncertain')).toMatchObject({
        state: 'payment-uncertain',
        persistenceFailures: ['receipt'],
      });
      expect(await store.getTransaction?.('txn_v4_first')).toMatchObject({
        payment: { status: 'rejected' },
      });
      // Manual resolution marks the payment settled; no delivery is recorded
      const page = await store.listTransactions?.({ unresolved: true });
      expect(page?.transactions.map((t) => t.id).sort()).toEqual([
        'txn_v4_resolved',
        'txn_v4_second',
        'txn_v4_uncertain',
      ]);
      await expect(
        store.reservePaymentAttempt({
          requestId: 'req_new',
          resourceId: 'resource.report',
          provider: 'x402',
          replayKey: 'replay_v4_delivered',
          amount: '0.01',
          currency: 'USDC',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_REPLAYED', details: { attemptStatus: 'settled' } });
    } finally {
      await store.close();
    }
  });

  it('reports schema v5 and its record capabilities', async () => {
    const store = open();
    try {
      await store.init();
      expect(store.descriptor.supportedSpec).toBe('sqlite-schema-v5');
      expect(store.descriptor.capabilities).toEqual(
        expect.arrayContaining(['idempotency-keys', 'authorization-holds', 'pending-tasks']),
      );
      expect(await store.health()).toMatchObject({
        status: 'pass',
        detail: 'sqlite schema v5 writable',
      });
    } finally {
      await store.close();
    }
  });

  it('leaves a v5 file unchanged when reopened', async () => {
    const first = open();
    await first.init();
    await first.reserveAuthorizationHold?.({
      method: 'ap2',
      reference: 'sha256:new',
      bindingReference: 'jti_new',
      resourceId: 'resource.report',
      requestId: 'req_new',
    });
    await first.close();
    const schema = schemaOf(path);
    const rows = dumpTables(path);

    const second = open();
    try {
      await second.init();
      expect(schemaOf(path)).toStrictEqual(schema);
      expect(dumpTables(path)).toStrictEqual(rows);
      expect(await second.getAuthorizationHoldState?.('sha256:new')).toBe('reserved');
    } finally {
      await second.close();
    }
  });

  // An older gateway meets a newer database the same way: its init() wants
  // exactly its own version, so a 2.5.x store refuses a v5 file
  it('refuses a file at a newer schema and leaves it untouched', async () => {
    const upgraded = open();
    await upgraded.init();
    await upgraded.close();
    const db = new Database(path);
    db.pragma('user_version = 6');
    db.close();
    const rows = dumpTables(path);

    const store = open();
    try {
      await expect(store.init()).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
        message: expect.stringContaining('found 6, expected 5'),
      });
      expect(await store.health()).toMatchObject({
        status: 'fail',
        detail: 'store-schema-mismatch',
      });
    } finally {
      await store.close();
    }
    expect(dumpTables(path)).toStrictEqual(rows);
    expect(schemaOf(path).version).toBe(6);
  });
});
