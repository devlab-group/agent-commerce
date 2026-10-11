import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isCommerceError,
  type PaymentAttemptReservation,
  type ReceiptStore,
} from '../../../src/core';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { createFakeClock, createFakeIds } from './helpers';

function makeReservation(
  overrides: Partial<PaymentAttemptReservation> = {},
): PaymentAttemptReservation {
  return {
    requestId: overrides.requestId ?? 'req_1',
    resourceId: overrides.resourceId ?? 'resource.report',
    provider: overrides.provider ?? 'x402',
    replayKey: overrides.replayKey ?? 'replay_1',
    amount: overrides.amount ?? '0.01',
    currency: overrides.currency ?? 'USDC',
    ...(overrides.payer !== undefined ? { payer: overrides.payer } : {}),
    ...(overrides.payee !== undefined ? { payee: overrides.payee } : {}),
    ...(overrides.reclaimRejected !== undefined
      ? { reclaimRejected: overrides.reclaimRejected }
      : {}),
  };
}

describe('reservePaymentAttempt', () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('reserves a fresh replayKey and returns a "reserved" PaymentAttempt', async () => {
    const reservation = makeReservation({
      replayKey: 'r_fresh',
      payer: '0xbuyer',
      payee: '0xmerchant',
    });
    const attempt = await store.reservePaymentAttempt(reservation);
    const expected = {
      id: 'attempt_1',
      requestId: 'req_1',
      resourceId: 'resource.report',
      provider: 'x402',
      replayKey: 'r_fresh',
      status: 'reserved',
      amount: '0.01',
      currency: 'USDC',
      payer: '0xbuyer',
      payee: '0xmerchant',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(attempt).toEqual(expected);
    expect(await store.listPaymentAttempts()).toEqual([expected]);
  });

  it('throws PAYMENT_REPLAYED on a duplicate replayKey', async () => {
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'dup' }));

    await expect(
      store.reservePaymentAttempt(makeReservation({ replayKey: 'dup', requestId: 'req_2' })),
    ).rejects.toSatisfy((err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_REPLAYED');
  });

  it('includes the existing attempt status in a duplicate reservation error', async () => {
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'dup' }));
    const duplicate = () =>
      store.reservePaymentAttempt(makeReservation({ replayKey: 'dup', requestId: 'req_2' }));

    await expect(duplicate()).rejects.toMatchObject({ details: { attemptStatus: 'reserved' } });
    await store.updatePaymentAttempt({ replayKey: 'dup', status: 'settled' });
    await expect(duplicate()).rejects.toMatchObject({ details: { attemptStatus: 'settled' } });
  });

  it('rejects a duplicate replayKey even when the second reservation targets a different request', async () => {
    // The replay key comes from the authorization, never the request id, so
    // the same authorization must collide across requests (docs/contracts.md,
    // required invariant 3)
    await store.reservePaymentAttempt(
      makeReservation({ replayKey: 'cross-request', requestId: 'req_a' }),
    );
    await expect(
      store.reservePaymentAttempt(
        makeReservation({ replayKey: 'cross-request', requestId: 'req_b' }),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_REPLAYED' });
  });

  it('handles a concurrent-ish double reservation atomically: exactly one wins', async () => {
    const reservation = makeReservation({ replayKey: 'race' });
    const results = await Promise.allSettled([
      store.reservePaymentAttempt(reservation),
      store.reservePaymentAttempt(reservation),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(isCommerceError(rejection.reason) && rejection.reason.code).toBe('PAYMENT_REPLAYED');

    // Only one row persisted
    const attempts = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempts.filter((a) => a.replayKey === 'race')).toHaveLength(1);
  });

  // A storage failure is not the buyer's replay: mislabeling it would refuse a
  // valid authorization as already spent
  it('reports a storage failure as STORAGE_ERROR, never PAYMENT_REPLAYED', async () => {
    const collidingIds = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: { next: () => 'attempt_same' },
    });
    await collidingIds.reservePaymentAttempt(makeReservation({ replayKey: 'first' }));
    // A UNIQUE violation on the attempt id, not on replay_key
    await expect(
      collidingIds.reservePaymentAttempt(makeReservation({ replayKey: 'second' })),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await collidingIds.close();

    await store.close();
    await expect(
      store.reservePaymentAttempt(makeReservation({ replayKey: 'after-close' })),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('still refuses a reserved replayKey after the store is reopened from its file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-replay-restart-'));
    const path = join(dir, 'receipts.sqlite');
    try {
      const first = createSqliteReceiptStore({ path });
      await first.reservePaymentAttempt(makeReservation({ replayKey: 'survives' }));
      await first.close();

      const second = createSqliteReceiptStore({ path });
      await expect(
        second.reservePaymentAttempt(
          makeReservation({ replayKey: 'survives', requestId: 'req_2' }),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_REPLAYED' });
      // Control: the reopened store still accepts a fresh key
      await expect(
        second.reservePaymentAttempt(makeReservation({ replayKey: 'fresh' })),
      ).resolves.toMatchObject({ status: 'reserved' });
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists payment attempts newest-first', async () => {
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'a' }));
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'b' }));
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'c' }));

    const listed = await store.listPaymentAttempts();
    expect(listed.map((a) => a.replayKey)).toEqual(['c', 'b', 'a']);
  });
});

// Rails that permit reusing an authorization can reclaim an attempt that was
// rejected, after a backend failure or a refused settlement: it settled nothing
describe('reclaiming a rejected attempt', () => {
  const retry = { reclaimRejected: true } as const;
  async function rejected(
    target: ReceiptStore,
    replayKey: string,
    rejectionReason = 'backend_failed',
  ): Promise<void> {
    await target.reservePaymentAttempt(makeReservation({ replayKey }));
    await target.updatePaymentAttempt({ replayKey, status: 'rejected', rejectionReason });
  }

  let store: ReceiptStore;

  beforeEach(async () => {
    store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it.each([
    'backend_failed',
    'invalid_exact_near_payload_delegate_action_expired',
    'insufficient_funds',
  ])('turns an attempt rejected with %s into the retry reservation', async (reason) => {
    await rejected(store, 'retry', reason);

    const reclaimed = await store.reservePaymentAttempt(
      makeReservation({ replayKey: 'retry', requestId: 'req_2', payer: '0xb', ...retry }),
    );

    expect(reclaimed).toMatchObject({
      id: 'attempt_2',
      requestId: 'req_2',
      replayKey: 'retry',
      status: 'reserved',
      payer: '0xb',
    });
    expect(reclaimed).not.toHaveProperty('rejectionReason');
    expect(await store.listPaymentAttempts()).toEqual([reclaimed]);
  });

  it('refuses it to a reservation that does not ask, or to another provider', async () => {
    await rejected(store, 'single-use');

    for (const reservation of [
      makeReservation({ replayKey: 'single-use', requestId: 'req_2' }),
      makeReservation({ replayKey: 'single-use', requestId: 'req_2', provider: 'mpp', ...retry }),
    ]) {
      await expect(store.reservePaymentAttempt(reservation)).rejects.toMatchObject({
        code: 'PAYMENT_REPLAYED',
        details: { attemptStatus: 'rejected' },
      });
    }
  });

  it('still refuses an attempt that is not rejected', async () => {
    const cases = [
      { status: 'reserved' },
      { status: 'verified' },
      { status: 'settled' },
      { status: 'settlement-uncertain' },
      { status: 'failed' },
      { status: 'settled', rejectionReason: 'backend_failed' },
    ] as const;
    for (const [index, update] of cases.entries()) {
      const replayKey = `kept_${index}`;
      await store.reservePaymentAttempt(makeReservation({ replayKey }));
      if (update.status !== 'reserved') await store.updatePaymentAttempt({ replayKey, ...update });

      await expect(
        store.reservePaymentAttempt(makeReservation({ replayKey, requestId: 'req_2', ...retry })),
        JSON.stringify(update),
      ).rejects.toMatchObject({
        code: 'PAYMENT_REPLAYED',
        details: { attemptStatus: update.status },
      });
    }
  });

  // The reclaim overwrites the attempt's row, so the row it replaces is kept
  it('keeps each attempt a reclaim replaces in payment_attempt_history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-history-'));
    const path = join(dir, 'receipts.sqlite');
    const file = createSqliteReceiptStore({ path, clock: createFakeClock(), ids: createFakeIds() });
    try {
      await rejected(file, 'twice', 'insufficient_funds');
      await file.reservePaymentAttempt(
        makeReservation({ replayKey: 'twice', requestId: 'req_2', ...retry }),
      );
      await file.updatePaymentAttempt({
        replayKey: 'twice',
        status: 'rejected',
        rejectionReason: 'backend_failed',
        externalReference: '0xfailed',
      });
      await file.reservePaymentAttempt(
        makeReservation({ replayKey: 'twice', requestId: 'req_3', ...retry }),
      );
      // A refused reclaim archives nothing
      await rejected(file, 'other');
      await expect(
        file.reservePaymentAttempt(
          makeReservation({ replayKey: 'other', requestId: 'req_4', provider: 'mpp', ...retry }),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_REPLAYED' });

      const db = new Database(path, { readonly: true });
      const history = db
        .prepare(
          'SELECT request_id, replay_key, status, rejection_reason, external_reference, superseded_at FROM payment_attempt_history ORDER BY seq',
        )
        .all();
      db.close();
      expect(history).toEqual([
        expect.objectContaining({
          request_id: 'req_1',
          replay_key: 'twice',
          status: 'rejected',
          rejection_reason: 'insufficient_funds',
          external_reference: null,
        }),
        expect.objectContaining({
          request_id: 'req_2',
          replay_key: 'twice',
          status: 'rejected',
          rejection_reason: 'backend_failed',
          external_reference: '0xfailed',
        }),
      ]);
      expect(
        history.every(
          (row) => typeof (row as { superseded_at: unknown }).superseded_at === 'string',
        ),
      ).toBe(true);
      expect((await file.listPaymentAttempts()).find((a) => a.replayKey === 'twice')).toMatchObject(
        { requestId: 'req_3', status: 'reserved' },
      );
    } finally {
      await file.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets one of two stores on the same file reclaim it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-reclaim-'));
    const path = join(dir, 'receipts.sqlite');
    const first = createSqliteReceiptStore({ path });
    const second = createSqliteReceiptStore({ path });
    try {
      await rejected(first, 'contested');

      const results = await Promise.allSettled([
        first.reservePaymentAttempt(
          makeReservation({ replayKey: 'contested', requestId: 'a', ...retry }),
        ),
        second.reservePaymentAttempt(
          makeReservation({ replayKey: 'contested', requestId: 'b', ...retry }),
        ),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({
        code: 'PAYMENT_REPLAYED',
        details: { attemptStatus: 'reserved' },
      });
    } finally {
      await first.close();
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('updatePaymentAttempt', () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('transitions reserved -> verified -> settled, recording the external reference', async () => {
    const reservation = makeReservation({ replayKey: 'lifecycle' });
    const reserved = await store.reservePaymentAttempt(reservation);
    expect(reserved.status).toBe('reserved');

    await store.updatePaymentAttempt({ replayKey: 'lifecycle', status: 'verified' });
    let [attempt] = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempt?.status).toBe('verified');

    await store.updatePaymentAttempt({
      replayKey: 'lifecycle',
      status: 'settled',
      externalReference: '0xtxhash',
    });
    [attempt] = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempt?.status).toBe('settled');
    expect(attempt?.externalReference).toBe('0xtxhash');
  });

  it('records a rejection reason on the failed/rejected path', async () => {
    const reservation = makeReservation({ replayKey: 'rejected-flow' });
    await store.reservePaymentAttempt(reservation);

    await store.updatePaymentAttempt({
      replayKey: 'rejected-flow',
      status: 'rejected',
      rejectionReason: 'wrong amount',
    });

    const [attempt] = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempt?.status).toBe('rejected');
    expect(attempt?.rejectionReason).toBe('wrong amount');
  });

  it('persists and returns the "settlement-uncertain" status with its transaction hash', async () => {
    // Broadcast but unconfirmed (an RPC timeout, say) is its own unresolved
    // state, not "failed". It round-trips with the broadcast tx hash in
    // externalReference so an operator can resolve it later.
    const reservation = makeReservation({ replayKey: 'uncertain-flow' });
    await store.reservePaymentAttempt(reservation);

    await store.updatePaymentAttempt({
      replayKey: 'uncertain-flow',
      status: 'settlement-uncertain',
      externalReference: '0xbroadcast_but_unconfirmed',
    });

    const [attempt] = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempt?.status).toBe('settlement-uncertain');
    expect(attempt?.externalReference).toBe('0xbroadcast_but_unconfirmed');
  });

  // A plain UPDATE would write NULL for every omitted field, erasing the tx
  // hash of a settlement-uncertain attempt on the next status-only update
  it('preserves externalReference across a later update that omits it', async () => {
    const reservation = makeReservation({ replayKey: 'preserve-ref' });
    await store.reservePaymentAttempt(reservation);

    await store.updatePaymentAttempt({
      replayKey: 'preserve-ref',
      status: 'settled',
      externalReference: '0xkeepme',
    });
    let [attempt] = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempt?.externalReference).toBe('0xkeepme');

    // A status-only update keeps the reference
    await store.updatePaymentAttempt({ replayKey: 'preserve-ref', status: 'settled' });
    [attempt] = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempt?.externalReference).toBe('0xkeepme');
  });

  it('preserves rejectionReason across a later update that omits it', async () => {
    const reservation = makeReservation({ replayKey: 'preserve-reason' });
    await store.reservePaymentAttempt(reservation);

    await store.updatePaymentAttempt({
      replayKey: 'preserve-reason',
      status: 'rejected',
      rejectionReason: 'wrong amount',
    });
    await store.updatePaymentAttempt({ replayKey: 'preserve-reason', status: 'rejected' });
    const [attempt] = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempt?.rejectionReason).toBe('wrong amount');
  });

  it('throws a typed error when the replayKey is unknown', async () => {
    await expect(
      store.updatePaymentAttempt({ replayKey: 'never-reserved', status: 'verified' }),
    ).rejects.toSatisfy((err: unknown) => isCommerceError(err) && err.code === 'STORAGE_ERROR');
  });
});
