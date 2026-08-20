import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isCommerceError,
  type PaymentAttemptReservation,
  type ReceiptStore,
} from '../../../src/core/index.js';
import { createSqliteReceiptStore } from '../../../src/storage/receipts/index.js';
import { createFakeClock, createFakeIds } from './helpers.js';

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
    const attempt = await store.reservePaymentAttempt(makeReservation({ replayKey: 'r_fresh' }));
    expect(attempt.status).toBe('reserved');
    expect(attempt.replayKey).toBe('r_fresh');
    expect(attempt.id).toBeTruthy();
    expect(attempt.createdAt).toBeTruthy();
    expect(attempt.updatedAt).toBeTruthy();
  });

  it('throws PAYMENT_REPLAYED on a duplicate replayKey', async () => {
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'dup' }));

    await expect(
      store.reservePaymentAttempt(makeReservation({ replayKey: 'dup', requestId: 'req_2' })),
    ).rejects.toSatisfy((err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_REPLAYED');
  });

  it('rejects a duplicate replayKey even when the second reservation targets a different request', async () => {
    // PaymentResult.replayKey is derived only from the authorisation, never the
    // request id, so the same authorisation replayed against a *different*
    // request must still collide (docs/contracts.md assumption 3).
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

    // Only one row should have actually been persisted.
    const attempts = await store.listPaymentAttempts({ requestId: reservation.requestId });
    expect(attempts.filter((a) => a.replayKey === 'race')).toHaveLength(1);
  });

  it('lists payment attempts newest-first', async () => {
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'a' }));
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'b' }));
    await store.reservePaymentAttempt(makeReservation({ replayKey: 'c' }));

    const listed = await store.listPaymentAttempts();
    expect(listed.map((a) => a.replayKey)).toEqual(['c', 'b', 'a']);
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
    // A settle() that broadcasts but cannot confirm (RPC timeout) is a
    // distinct terminal state from "failed". The store must
    // round-trip it like any other status, with the broadcast tx hash
    // carried as externalReference so an operator can resolve it later.
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

  // A naive UPDATE writes NULL for every omitted field, so a status-only
  // update (no externalReference re-supplied) would erase a reference set by
  // a prior update — exactly the field a settlement-uncertain attempt's tx
  // hash lives in.
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

    // A later update that only changes status, without re-supplying the
    // reference, must not erase it.
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
