// SQLite transaction journal: atomic reservations, recorded steps, derived state and resolution
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Clock,
  PaymentAttemptReservation,
  PaymentAttemptResolution,
  ReceiptStore,
  Transaction,
  TransactionPage,
} from '../../../src/core';
import {
  createSqliteReceiptStore,
  type SqliteReceiptStoreOptions,
} from '../../../src/storage/receipts';
import { createFakeIds, makeEvent, makeReceipt } from './helpers';

const T0 = '2026-10-28T12:00:00.000Z';
const T1 = '2026-10-28T12:00:01.000Z';
const T2 = '2026-10-28T12:00:02.000Z';
const T3 = '2026-10-28T12:00:03.000Z';
const T4 = '2026-10-28T12:00:04.000Z';
const T5 = '2026-10-28T12:00:05.000Z';
const DEADLINE = '2026-10-28T12:00:33.000Z';
const AFTER_DEADLINE = '2026-10-28T12:00:40.000Z';

// Keep timestamps fixed until the test calls set
function stoppedClock(start: string): Clock & { set(iso: string): void } {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    nowIso: () => new Date(ms).toISOString(),
    monotonicMs: () => ms,
    set(iso) {
      ms = Date.parse(iso);
    },
  };
}

function reservation(
  n: number,
  overrides: Partial<PaymentAttemptReservation> = {},
): PaymentAttemptReservation {
  return {
    requestId: `req_${n}`,
    resourceId: 'resource.report',
    provider: 'x402',
    replayKey: `replay_${n}`,
    amount: '0.01',
    currency: 'USDC',
    payee: '0xmerchant',
    transaction: { id: `txn_${n}`, protocol: 'mcp', configDigest: 'sha256:terms' },
    ...overrides,
  };
}

const RESOLUTION: PaymentAttemptResolution = {
  method: 'reconcile',
  actor: 'agent-commerce reconcile',
  reason: 'transfer_found',
  at: T3,
  externalReference: '0xlanded',
  evidence: { blockNumber: 12 },
};

// SQLite implements the optional journal methods, so tests can call them directly
type JournalStore = Required<ReceiptStore>;
const openStore = (options: SqliteReceiptStoreOptions) =>
  createSqliteReceiptStore(options) as JournalStore;

const ids = (page: TransactionPage) => page.transactions.map((t: Transaction) => t.id);

function cursorOf(page: TransactionPage): string {
  if (page.nextCursor === undefined) throw new Error('expected a next cursor');
  return page.nextCursor;
}

describe('transaction journal', () => {
  let clock: ReturnType<typeof stoppedClock>;
  let store: JournalStore;

  beforeEach(async () => {
    clock = stoppedClock(T0);
    store = openStore({ path: ':memory:', clock, ids: createFakeIds() });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('a reservation with transaction data', () => {
    it('opens a journal row linked to the attempt, with the hold reserved', async () => {
      const attempt = await store.reservePaymentAttempt(
        reservation(1, {
          payer: '0xbuyer',
          transaction: {
            id: 'txn_1',
            protocol: 'mcp',
            network: 'eip155:31337',
            asset: '0xasset',
            locator: { v: 1, nonce: '0xnonce' },
            expiresAt: '2026-10-28T12:05:00.000Z',
            authorization: {
              method: 'ap2',
              reference: 'sha256:mandate',
              metadata: { issuer: 'did:web:agent.example' },
              reservationId: 'sha256:mandate',
            },
            inputDigest: 'sha256:input',
            configDigest: 'sha256:terms',
          },
        }),
      );

      expect(attempt).toMatchObject({ id: 'attempt_1', transactionId: 'txn_1' });
      expect(await store.getTransaction('txn_1')).toStrictEqual({
        id: 'txn_1',
        requestId: 'req_1',
        resourceId: 'resource.report',
        protocol: 'mcp',
        state: 'payment-pending',
        payment: {
          provider: 'x402',
          attemptId: 'attempt_1',
          replayKey: 'replay_1',
          status: 'reserved',
          amount: '0.01',
          currency: 'USDC',
          network: 'eip155:31337',
          asset: '0xasset',
          payee: '0xmerchant',
          locator: { v: 1, nonce: '0xnonce' },
          expiresAt: '2026-10-28T12:05:00.000Z',
        },
        authorization: {
          method: 'ap2',
          reference: 'sha256:mandate',
          metadata: { issuer: 'did:web:agent.example' },
          hold: 'reserved',
          reservationId: 'sha256:mandate',
        },
        inputDigest: 'sha256:input',
        configDigest: 'sha256:terms',
        createdAt: T0,
        updatedAt: T0,
      });
    });

    it('opens no row without transaction data', async () => {
      const { transaction: _none, ...plain } = reservation(1);
      const attempt = await store.reservePaymentAttempt(plain);
      expect(attempt).not.toHaveProperty('transactionId');
      expect(await store.listTransactions()).toStrictEqual({ transactions: [] });
    });

    it('keeps neither the attempt nor the row when the journal insert fails', async () => {
      await store.reservePaymentAttempt(reservation(1));
      const duplicate = reservation(2, {
        transaction: { id: 'txn_1', protocol: 'mcp', configDigest: 'sha256:terms' },
      });

      await expect(store.reservePaymentAttempt(duplicate)).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
      });
      expect((await store.listPaymentAttempts()).map((a) => a.replayKey)).toEqual(['replay_1']);
      expect(await store.getTransaction('txn_1')).toMatchObject({ requestId: 'req_1' });
      // Rollback must leave the replay key available for a new reservation
      await expect(store.reservePaymentAttempt(reservation(2))).resolves.toMatchObject({
        replayKey: 'replay_2',
        transactionId: 'txn_2',
      });
    });

    it('writes no row for a replay it refuses', async () => {
      await store.reservePaymentAttempt(reservation(1));

      await expect(
        store.reservePaymentAttempt(
          reservation(2, { replayKey: 'replay_1', requestId: 'req_replay' }),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_REPLAYED' });
      expect(await store.getTransaction('txn_2')).toBeUndefined();
      expect(ids(await store.listTransactions())).toEqual(['txn_1']);
    });
  });

  describe('steps', () => {
    it('records each step of a paid delivery and derives delivered at the end', async () => {
      await store.reservePaymentAttempt(
        reservation(1, {
          transaction: {
            id: 'txn_1',
            protocol: 'http',
            authorization: { method: 'ap2', reference: 'sha256:m', reservationId: 'sha256:m' },
            configDigest: 'sha256:terms',
          },
        }),
      );
      await store.recordTransactionStep({ transactionId: 'txn_1', at: T1, kind: 'settling' });
      clock.set(T2);
      await store.updatePaymentAttempt({
        replayKey: 'replay_1',
        status: 'settled',
        externalReference: '0xtx',
      });
      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T2,
        kind: 'hold',
        hold: 'consumed',
      });
      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T3,
        kind: 'backend-dispatched',
        deadlineAt: DEADLINE,
      });
      clock.set(T3);
      expect((await store.getTransaction('txn_1'))?.state).toBe('delivery-started');

      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T4,
        kind: 'backend-result',
        status: 200,
      });
      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T4,
        kind: 'receipt',
        receiptId: 'receipt_1',
      });
      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T5,
        kind: 'completed',
        persistenceFailures: ['journal'],
      });
      clock.set(AFTER_DEADLINE);

      expect(await store.getTransaction('txn_1')).toStrictEqual({
        id: 'txn_1',
        requestId: 'req_1',
        resourceId: 'resource.report',
        protocol: 'http',
        state: 'delivered',
        payment: {
          provider: 'x402',
          attemptId: 'attempt_1',
          replayKey: 'replay_1',
          status: 'settled',
          amount: '0.01',
          currency: 'USDC',
          payee: '0xmerchant',
          externalReference: '0xtx',
          settlingAt: T1,
        },
        authorization: {
          method: 'ap2',
          reference: 'sha256:m',
          hold: 'consumed',
          reservationId: 'sha256:m',
        },
        backend: { dispatchedAt: T3, deadlineAt: DEADLINE, status: 200 },
        receiptId: 'receipt_1',
        configDigest: 'sha256:terms',
        persistenceFailures: ['journal'],
        createdAt: T0,
        updatedAt: T5,
        completedAt: T5,
      });
      expect(ids(await store.listTransactions({ state: 'delivered' }))).toEqual(['txn_1']);
    });

    it('records a backend failure with its error code', async () => {
      await store.reservePaymentAttempt(reservation(1));
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settled' });
      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T1,
        kind: 'backend-dispatched',
        deadlineAt: DEADLINE,
      });
      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T2,
        kind: 'backend-result',
        status: 0,
        errorCode: 'BACKEND_TIMEOUT',
      });
      await store.recordTransactionStep({
        transactionId: 'txn_1',
        at: T3,
        kind: 'completed',
        persistenceFailures: [],
      });

      const transaction = await store.getTransaction('txn_1');
      expect(transaction).toMatchObject({
        state: 'delivery-unknown',
        backend: {
          dispatchedAt: T1,
          deadlineAt: DEADLINE,
          status: 0,
          errorCode: 'BACKEND_TIMEOUT',
        },
        completedAt: T3,
      });
      // Omit persistenceFailures when the list is empty
      expect(transaction).not.toHaveProperty('persistenceFailures');
    });

    it('refuses a step for an unknown transaction with STORAGE_ERROR', async () => {
      await expect(
        store.recordTransactionStep({ transactionId: 'txn_missing', at: T1, kind: 'settling' }),
      ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });

    it('refuses a hold step for a transaction without an authorization, changing nothing', async () => {
      await store.reservePaymentAttempt(reservation(1));
      const before = await store.getTransaction('txn_1');

      await expect(
        store.recordTransactionStep({
          transactionId: 'txn_1',
          at: T1,
          kind: 'hold',
          hold: 'released',
        }),
      ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      expect(await store.getTransaction('txn_1')).toStrictEqual(before);
    });
  });

  describe('state', () => {
    it.each([
      ['settled', 'settled-undelivered'],
      ['rejected', 'payment-failed'],
      ['settlement-uncertain', 'payment-uncertain'],
      ['failed', 'payment-uncertain'],
    ] as const)(
      'moves with an attempt update to %s, so a filter on %s finds it',
      async (status, state) => {
        await store.reservePaymentAttempt(reservation(1));
        expect(ids(await store.listTransactions({ state }))).toEqual([]);

        await store.updatePaymentAttempt({ replayKey: 'replay_1', status });

        expect(ids(await store.listTransactions({ state }))).toEqual(['txn_1']);
        expect((await store.getTransaction('txn_1'))?.state).toBe(state);
      },
    );

    it.each([
      ['settled', 'delivery-unknown'],
      ['reserved', 'payment-pending'],
    ] as const)(
      'reads a %s payment whose backend deadline passed without a write as %s',
      async (status, after) => {
        await store.reservePaymentAttempt(reservation(1));
        if (status !== 'reserved')
          await store.updatePaymentAttempt({ replayKey: 'replay_1', status });
        await store.recordTransactionStep({
          transactionId: 'txn_1',
          at: T1,
          kind: 'backend-dispatched',
          deadlineAt: DEADLINE,
        });
        const listed = async (state: string) => ids(await store.listTransactions({ state }));

        clock.set(T2);
        expect((await store.getTransaction('txn_1'))?.state).toBe('delivery-started');
        expect(await listed('delivery-started')).toEqual(['txn_1']);
        expect(await listed(after)).toEqual([]);

        clock.set(AFTER_DEADLINE);
        expect((await store.getTransaction('txn_1'))?.state).toBe(after);
        expect(await listed(after)).toEqual(['txn_1']);
        expect(await listed('delivery-started')).toEqual([]);
      },
    );
  });

  describe('a reclaim', () => {
    const retry = (n: number) => reservation(n, { replayKey: 'replay_1', reclaimRejected: true });

    it('archives the attempt with its resolution and opens a new row', async () => {
      await store.reservePaymentAttempt(reservation(1));
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settlement-uncertain' });
      await store.resolvePaymentAttempt({
        attemptId: 'attempt_1',
        expectedStatus: 'settlement-uncertain',
        status: 'rejected',
        rejectionReason: 'not_settled',
        resolution: { ...RESOLUTION, reason: 'nonce_unused' },
      });
      clock.set(T4);

      const reclaimed = await store.reservePaymentAttempt(retry(2));

      expect(reclaimed).toMatchObject({ id: 'attempt_2', transactionId: 'txn_2' });
      expect(reclaimed).not.toHaveProperty('resolution');
      expect(await store.getPaymentAttempt('attempt_1')).toStrictEqual({
        id: 'attempt_1',
        requestId: 'req_1',
        resourceId: 'resource.report',
        provider: 'x402',
        replayKey: 'replay_1',
        status: 'rejected',
        amount: '0.01',
        currency: 'USDC',
        payee: '0xmerchant',
        externalReference: '0xlanded',
        rejectionReason: 'not_settled',
        createdAt: T0,
        updatedAt: T0,
        transactionId: 'txn_1',
        resolution: { ...RESOLUTION, reason: 'nonce_unused' },
      });
      expect(await store.getTransaction('txn_1')).toMatchObject({
        state: 'payment-failed',
        payment: { attemptId: 'attempt_1', status: 'rejected', externalReference: '0xlanded' },
      });
      expect(await store.getTransaction('txn_2')).toMatchObject({
        requestId: 'req_2',
        state: 'payment-pending',
        payment: { attemptId: 'attempt_2', status: 'reserved' },
        createdAt: T4,
      });
    });

    it('moves only the new row when the reclaimed attempt settles', async () => {
      await store.reservePaymentAttempt(reservation(1));
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'rejected' });
      await store.reservePaymentAttempt(retry(2));

      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settled' });

      expect((await store.getTransaction('txn_1'))?.state).toBe('payment-failed');
      expect((await store.getTransaction('txn_2'))?.state).toBe('settled-undelivered');
      expect(ids(await store.listTransactions({ state: 'payment-failed' }))).toEqual(['txn_1']);
    });

    it('keeps the rejected attempt and archives nothing when the journal insert fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oac-journal-'));
      const path = join(dir, 'receipts.sqlite');
      const file = openStore({ path, clock, ids: createFakeIds() });
      try {
        await file.reservePaymentAttempt(reservation(1));
        await file.updatePaymentAttempt({ replayKey: 'replay_1', status: 'rejected' });

        await expect(
          file.reservePaymentAttempt(
            reservation(2, {
              replayKey: 'replay_1',
              reclaimRejected: true,
              transaction: { id: 'txn_1', protocol: 'mcp', configDigest: 'sha256:terms' },
            }),
          ),
        ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });

        expect(await file.listPaymentAttempts()).toMatchObject([
          { id: 'attempt_1', status: 'rejected', transactionId: 'txn_1' },
        ]);
        const db = new Database(path, { readonly: true });
        const archived = db.prepare('SELECT COUNT(*) AS n FROM payment_attempt_history').get();
        db.close();
        expect(archived).toEqual({ n: 0 });
      } finally {
        await file.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('resolvePaymentAttempt', () => {
    beforeEach(async () => {
      await store.reservePaymentAttempt(reservation(1));
      await store.updatePaymentAttempt({
        replayKey: 'replay_1',
        status: 'settlement-uncertain',
        externalReference: '0xpending',
      });
    });

    it('settles an uncertain attempt with its resolution and moves the transaction', async () => {
      clock.set(T3);
      await expect(
        store.resolvePaymentAttempt({
          attemptId: 'attempt_1',
          expectedStatus: 'settlement-uncertain',
          status: 'settled',
          resolution: RESOLUTION,
        }),
      ).resolves.toBe(true);

      expect(await store.getPaymentAttempt('attempt_1')).toMatchObject({
        status: 'settled',
        externalReference: '0xlanded',
        resolution: RESOLUTION,
        updatedAt: T3,
      });
      expect(
        ids(
          (await store.listTransactions({ state: 'settled-undelivered' })) ?? {
            transactions: [],
          },
        ),
      ).toEqual(['txn_1']);
    });

    it('rejects an uncertain attempt with its reason and keeps the stored reference', async () => {
      const { externalReference: _omitted, ...withoutReference } = RESOLUTION;
      await store.resolvePaymentAttempt({
        attemptId: 'attempt_1',
        expectedStatus: 'settlement-uncertain',
        status: 'rejected',
        rejectionReason: 'not_settled',
        resolution: withoutReference,
      });

      expect(await store.getPaymentAttempt('attempt_1')).toMatchObject({
        status: 'rejected',
        rejectionReason: 'not_settled',
        externalReference: '0xpending',
        resolution: withoutReference,
      });
      expect((await store.getTransaction('txn_1'))?.state).toBe('payment-failed');
    });

    it.each([
      ['the status differs', { attemptId: 'attempt_1', expectedStatus: 'reserved' }],
      [
        'the attempt is unknown',
        { attemptId: 'attempt_missing', expectedStatus: 'settlement-uncertain' },
      ],
    ] as const)('writes nothing and returns false when %s', async (_case, target) => {
      const before = await store.getPaymentAttempt('attempt_1');

      await expect(
        store.resolvePaymentAttempt({ ...target, status: 'settled', resolution: RESOLUTION }),
      ).resolves.toBe(false);
      expect(await store.getPaymentAttempt('attempt_1')).toStrictEqual(before);
      expect((await store.getTransaction('txn_1'))?.state).toBe('payment-uncertain');
    });

    it('refuses a second resolution even when the expected status matches', async () => {
      await store.resolvePaymentAttempt({
        attemptId: 'attempt_1',
        expectedStatus: 'settlement-uncertain',
        status: 'settled',
        resolution: RESOLUTION,
      });

      await expect(
        store.resolvePaymentAttempt({
          attemptId: 'attempt_1',
          expectedStatus: 'settled',
          status: 'rejected',
          resolution: { ...RESOLUTION, method: 'manual', actor: 'operator' },
        }),
      ).resolves.toBe(false);
      expect(await store.getPaymentAttempt('attempt_1')).toMatchObject({
        status: 'settled',
        resolution: RESOLUTION,
      });
    });

    // A compare-and-set miss returns false; a database write failure must throw
    it('reports a store failure as STORAGE_ERROR, never as false', async () => {
      await store.close();
      await expect(
        store.resolvePaymentAttempt({
          attemptId: 'attempt_1',
          expectedStatus: 'settlement-uncertain',
          status: 'settled',
          resolution: RESOLUTION,
        }),
      ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });

    it('refuses an archived attempt', async () => {
      await store.resolvePaymentAttempt({
        attemptId: 'attempt_1',
        expectedStatus: 'settlement-uncertain',
        status: 'rejected',
        resolution: RESOLUTION,
      });
      // Reclaim archives the rejected attempt and its resolution
      await store.reservePaymentAttempt(
        reservation(2, { replayKey: 'replay_1', reclaimRejected: true }),
      );

      await expect(
        store.resolvePaymentAttempt({
          attemptId: 'attempt_1',
          expectedStatus: 'rejected',
          status: 'settled',
          resolution: RESOLUTION,
        }),
      ).resolves.toBe(false);
    });
  });

  it('lets one of two resolutions from separate connections write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-journal-'));
    const path = join(dir, 'receipts.sqlite');
    const first = openStore({ path, clock, ids: createFakeIds() });
    const second = openStore({ path, clock, ids: createFakeIds() });
    try {
      await first.reservePaymentAttempt(reservation(1));
      await first.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settlement-uncertain' });
      const manual = { ...RESOLUTION, method: 'manual', actor: 'operator' } as const;

      const results = await Promise.all([
        first.resolvePaymentAttempt({
          attemptId: 'attempt_1',
          expectedStatus: 'settlement-uncertain',
          status: 'settled',
          resolution: RESOLUTION,
        }),
        second.resolvePaymentAttempt({
          attemptId: 'attempt_1',
          expectedStatus: 'settlement-uncertain',
          status: 'rejected',
          resolution: manual,
        }),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] === true ? RESOLUTION : manual;
      expect((await second.getPaymentAttempt('attempt_1'))?.resolution).toStrictEqual(winner);
    } finally {
      await first.close();
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('listTransactions', () => {
    const reserveMany = async (target: JournalStore, from: number, to: number) => {
      for (let n = from; n <= to; n += 1) await target.reservePaymentAttempt(reservation(n));
    };

    it('pages newest first and stays stable while rows are added', async () => {
      await reserveMany(store, 1, 5);

      const first = await store.listTransactions({ limit: 2 });
      await reserveMany(store, 6, 7);
      const second = await store.listTransactions({ limit: 2, cursor: cursorOf(first) });
      const third = await store.listTransactions({ limit: 2, cursor: cursorOf(second) });

      expect(ids(first)).toEqual(['txn_5', 'txn_4']);
      expect(ids(second)).toEqual(['txn_3', 'txn_2']);
      expect(third).toMatchObject({ transactions: [{ id: 'txn_1' }] });
      expect(third).not.toHaveProperty('nextCursor');
    });

    it('gives a cursor after a full last page, which then reads empty', async () => {
      await reserveMany(store, 1, 2);
      const full = await store.listTransactions({ limit: 2 });
      expect(await store.listTransactions({ limit: 2, cursor: cursorOf(full) })).toStrictEqual({
        transactions: [],
      });
    });

    it.each(['', 'abc', '0', '-1', '1.5', ' 1', '01', '12345678901234567'])(
      'refuses the malformed cursor %j with INPUT_INVALID',
      async (cursor) => {
        await expect(store.listTransactions({ cursor })).rejects.toMatchObject({
          code: 'INPUT_INVALID',
        });
      },
    );

    it.each([
      [0, 1],
      [-1, 1],
      [Number.NaN, 50],
      [1000, 500],
    ])('clamps a limit of %d to %d', async (limit, expected) => {
      await reserveMany(store, 1, 501);
      expect((await store.listTransactions({ limit }))?.transactions).toHaveLength(expected);
    });

    it('filters by request and by unresolved state', async () => {
      await reserveMany(store, 1, 3);
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'rejected' });
      await store.updatePaymentAttempt({ replayKey: 'replay_2', status: 'settled' });

      expect(ids(await store.listTransactions({ requestId: 'req_2' }))).toEqual(['txn_2']);
      expect(ids(await store.listTransactions({ unresolved: true }))).toEqual(['txn_3', 'txn_2']);
    });
  });

  describe('getPaymentAttempt', () => {
    it('returns undefined for an unknown id', async () => {
      expect(await store.getPaymentAttempt('attempt_missing')).toBeUndefined();
    });
  });

  it('round-trips the transaction id on receipts and events', async () => {
    await store.saveReceipt({ ...makeReceipt({ id: 'receipt_1' }), transactionId: 'txn_1' });
    await store.appendEvent({ ...makeEvent({ id: 'event_1' }), transactionId: 'txn_1' });

    expect(await store.getReceipt('receipt_1')).toMatchObject({ transactionId: 'txn_1' });
    expect(await store.listEvents()).toMatchObject([{ id: 'event_1', transactionId: 'txn_1' }]);
  });
});

describe('journal redaction', () => {
  it('stores no secret-shaped value from a locator, an authorization or a resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-journal-secrets-'));
    const path = join(dir, 'receipts.sqlite');
    const secret = 'THIS_MUST_NEVER_BE_STORED_VERBATIM';
    const visible = 'VISIBLE_JOURNAL_VALUE';
    const store = openStore({ path, clock: stoppedClock(T0), ids: createFakeIds() });
    try {
      await store.reservePaymentAttempt(
        reservation(1, {
          transaction: {
            id: 'txn_1',
            protocol: 'mcp',
            locator: { v: 1, nonce: visible, signature: secret },
            authorization: {
              method: 'ap2',
              reference: 'sha256:m',
              metadata: { mandateToken: secret },
              reservationId: 'sha256:m',
            },
            configDigest: 'sha256:terms',
          },
        }),
      );
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settlement-uncertain' });
      await store.resolvePaymentAttempt({
        attemptId: 'attempt_1',
        expectedStatus: 'settlement-uncertain',
        status: 'settled',
        resolution: { ...RESOLUTION, evidence: { privateKey: secret, block: visible } },
      });

      expect(await store.getTransaction('txn_1')).toMatchObject({
        payment: { locator: { v: 1, nonce: visible, signature: '[REDACTED]' } },
        authorization: { metadata: { mandateToken: '[REDACTED]' } },
      });
      expect((await store.getPaymentAttempt('attempt_1'))?.resolution?.evidence).toStrictEqual({
        privateKey: '[REDACTED]',
        block: visible,
      });
      await store.close();

      const onDisk = [path, `${path}-wal`, `${path}-shm`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file).toString('latin1'))
        .join('');
      expect(onDisk).toContain(visible);
      expect(onDisk).not.toContain(secret);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
