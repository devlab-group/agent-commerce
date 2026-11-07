// Test the SQLite store's diagnostic summary
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteReceiptStore, type SqliteReceiptStore } from '../../../src/storage/receipts';
import {
  type ConformanceClock,
  createConformanceClock,
  isoAt,
} from '../../../src/testing/conformance/support';

const MINUTE = 60_000;
const AGE = { orphanHoldMinAgeMs: 15 * MINUTE };

const purchase = (n: number) => ({
  requestId: `req_${n}`,
  resourceId: 'resource.report',
  provider: 'x402',
  replayKey: `replay_${n}`,
  amount: '0.01',
  currency: 'USDC',
  transaction: { id: `txn_${n}`, protocol: 'mcp' as const, configDigest: 'sha256:terms' },
});

describe('SQLite receipt store summary', () => {
  let dir: string;
  let path: string;
  let clock: ConformanceClock;
  let store: SqliteReceiptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-summary-'));
    path = join(dir, 'receipts.sqlite');
    clock = createConformanceClock();
    store = createSqliteReceiptStore({ path, clock });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is empty for a new store', async () => {
    expect(await store.summary(AGE)).toEqual({
      unresolvedTransactions: {},
      orphanHolds: 0,
      unresolvedIdempotencyKeys: 0,
      unresolvedPaymentKeys: 0,
      unexpiredPendingTasks: 0,
      legacyImports: [],
      missingLegacyImports: [],
    });
  });

  it('counts unresolved transactions by the state derived when read', async () => {
    await store.reservePaymentAttempt(purchase(1));
    await store.reservePaymentAttempt(purchase(2));
    await store.updatePaymentAttempt({ replayKey: 'replay_2', status: 'settlement-uncertain' });
    // Delivered, so not counted
    await store.reservePaymentAttempt(purchase(3));
    await store.updatePaymentAttempt({ replayKey: 'replay_3', status: 'settled' });
    await store.recordTransactionStep?.({
      transactionId: 'txn_3',
      at: isoAt(0),
      kind: 'backend-result',
      status: 200,
    });
    await store.recordTransactionStep?.({
      transactionId: 'txn_3',
      at: isoAt(0),
      kind: 'completed',
    });
    // Settled, with no recorded backend result before the deadline
    await store.reservePaymentAttempt(purchase(4));
    await store.updatePaymentAttempt({ replayKey: 'replay_4', status: 'settled' });
    await store.recordTransactionStep?.({
      transactionId: 'txn_4',
      at: isoAt(0),
      kind: 'backend-dispatched',
      deadlineAt: isoAt(MINUTE),
    });

    expect((await store.summary(AGE)).unresolvedTransactions).toEqual({
      'payment-pending': 1,
      'payment-uncertain': 1,
      'delivery-started': 1,
    });
    clock.advance(MINUTE + 1);
    expect((await store.summary(AGE)).unresolvedTransactions).toEqual({
      'payment-pending': 1,
      'payment-uncertain': 1,
      'delivery-unknown': 1,
    });
  });

  it('counts orphan holds older than the age, unresolved keys and unexpired tasks', async () => {
    const hold = (reference: string, requestId: string) =>
      store.reserveAuthorizationHold({
        method: 'ap2',
        reference,
        bindingReference: `jti_${reference}`,
        resourceId: 'resource.report',
        requestId,
      });
    await hold('old', 'req_old');
    await hold('paying', 'req_1');
    await store.reservePaymentAttempt(purchase(1));
    clock.advance(10 * MINUTE);
    await hold('young', 'req_young');
    clock.advance(6 * MINUTE);

    const scope = (key: string) => ({ deployment: 'https://gw.example', endpoint: '/acp', key });
    await store.claimIdempotencyKey(scope('running'), 'fp', isoAt(60 * MINUTE));
    await store.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(60 * MINUTE));
    await store.updateIdempotencyKey(scope('unknown'), { kind: 'unresolved' });

    const task = (id: string, expiresAt: string) => ({
      id,
      protocol: 'a2a' as const,
      resourceId: 'resource.report',
      input: {},
      expiresAt,
    });
    await store.putPendingTask(task('live', isoAt(60 * MINUTE)), { maxTasks: 10 });
    await store.putPendingTask(task('stale', isoAt(17 * MINUTE)), { maxTasks: 10 });
    clock.advance(2 * MINUTE);

    expect(await store.summary(AGE)).toMatchObject({
      orphanHolds: 1,
      unresolvedIdempotencyKeys: 1,
      unexpiredPendingTasks: 1,
    });
  });

  it('counts unresolved payment keys apart from other claims', async () => {
    const scope = (endpoint: string, key: string) => ({
      deployment: 'https://gw.example',
      endpoint,
      key,
    });
    const leaveUnresolved = async (endpoint: string, key: string) => {
      await store.claimIdempotencyKey(scope(endpoint, key), 'fp', isoAt(60 * MINUTE));
      await store.updateIdempotencyKey(scope(endpoint, key), { kind: 'unresolved' });
    };
    await leaveUnresolved('/acp/checkout_sessions', 'a');
    await leaveUnresolved('/payment:mount/checkout_sessions', 'b');
    await leaveUnresolved('payment:report', 'c');
    await leaveUnresolved('payment:report', 'd');
    await leaveUnresolved('payment:forecast', 'e');
    await store.claimIdempotencyKey(scope('payment:report', 'running'), 'fp', isoAt(60 * MINUTE));

    expect(await store.summary(AGE)).toMatchObject({
      unresolvedIdempotencyKeys: 2,
      unresolvedPaymentKeys: 3,
    });
  });

  it('stops counting a payment key once its retention ends, and keeps counting other claims', async () => {
    const scope = (endpoint: string) => ({ deployment: 'https://gw.example', endpoint, key: 'k' });
    for (const endpoint of ['/acp/checkout_sessions', 'payment:report']) {
      await store.claimIdempotencyKey(scope(endpoint), 'fp', isoAt(MINUTE));
      await store.updateIdempotencyKey(scope(endpoint), { kind: 'unresolved' });
    }

    clock.advance(MINUTE - 1);
    const before = await store.summary(AGE);
    clock.advance(1);
    const after = await store.summary(AGE);

    expect(before).toMatchObject({ unresolvedIdempotencyKeys: 1, unresolvedPaymentKeys: 1 });
    expect(after).toMatchObject({ unresolvedIdempotencyKeys: 1, unresolvedPaymentKeys: 0 });
  });

  it('lists the recorded legacy imports, not a start with nothing to import', async () => {
    const db = new Database(path);
    const insert = db.prepare(
      'INSERT INTO legacy_imports (source, path, rows, imported_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('ap2-replay', '/data/ap2.sqlite', 3, isoAt(0));
    insert.run('acp-idempotency', null, 0, isoAt(0));
    db.close();

    expect(await store.summary(AGE)).toMatchObject({
      legacyImports: [
        { source: 'ap2-replay', path: '/data/ap2.sqlite', rows: 3, importedAt: isoAt(0) },
      ],
      missingLegacyImports: [],
    });
  });

  it('names a feature that used the database with nothing recorded for it', async () => {
    await store.appendEvent({
      id: 'event_acp',
      type: 'resource.requested',
      requestId: 'req_acp',
      at: isoAt(0),
      adapter: 'acp',
    } as Parameters<typeof store.appendEvent>[0]);

    expect((await store.summary(AGE)).missingLegacyImports).toEqual(['acp-idempotency']);
  });
});
