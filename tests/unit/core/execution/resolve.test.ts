// Manual resolution and AP2 hold updates using SQLite
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Ap2ReplayStore,
  createAp2ReplayStore,
} from '../../../../src/authorization/ap2/replay-store';
import type {
  AuthorizationProvider,
  Clock,
  PaymentAttemptReservation,
  PaymentProvider,
  PaymentReconciliationResult,
  ReceiptStore,
} from '../../../../src/core';
import { isCommerceError } from '../../../../src/core';
import { resolveManually, runReconcile } from '../../../../src/core/execution/reconcile';
import { createSqliteReceiptStore } from '../../../../src/storage/receipts';

const T0 = '2026-10-28T12:00:00.000Z';
const RUN_AT = '2026-10-28T12:30:00.000Z';
const EXPIRES_AT = '2026-10-28T12:10:00.000Z';
const LOCATOR = { v: 1, network: 'eip155:84532', method: 'eip3009', nonce: `0x${'ab'.repeat(32)}` };

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

// Wrap the replay store with an AP2 test provider and record each call
function holdProvider(replay: Ap2ReplayStore, fail = false) {
  const calls: string[] = [];
  const finalize =
    (action: 'consume' | 'release' | 'markUncertain') =>
    async (reservationId: string, context: { requestId: string; resourceId: string }) => {
      calls.push(`${action} ${reservationId} ${context.requestId} ${context.resourceId}`);
      if (fail) throw new Error('replay database locked');
      replay[action](reservationId, context.requestId);
    };
  const provider = {
    name: 'ap2',
    descriptor: {
      name: 'ap2',
      kind: 'authorization',
      implementationVersion: '0',
      supportedSpec: 't',
    },
    requirement: { method: 'ap2', version: '0.2.0', profile: 'test' },
    verifyAndReserve: vi.fn(),
    consume: finalize('consume'),
    release: finalize('release'),
    markUncertain: finalize('markUncertain'),
    health: vi.fn(),
  } as unknown as AuthorizationProvider;
  return { provider, calls };
}

function fakePayments(answers: Record<string, PaymentReconciliationResult>): PaymentProvider {
  return {
    name: 'x402',
    descriptor: { name: 'x402', kind: 'payment', implementationVersion: '0', supportedSpec: 't' },
    async reconcile({ attempt }: { attempt: { requestId: string } }) {
      return answers[attempt.requestId] ?? { outcome: 'unknown', reason: 'unset' };
    },
  } as unknown as PaymentProvider;
}

let clock: ReturnType<typeof stoppedClock>;
let store: ReceiptStore;
let replay: Ap2ReplayStore;

beforeEach(async () => {
  clock = stoppedClock(T0);
  store = createSqliteReceiptStore({ path: ':memory:', clock });
  await store.init();
  replay = createAp2ReplayStore({ path: ':memory:' });
});

afterEach(async () => {
  await store.close();
  replay.close();
});

interface Seed {
  readonly mandate?: boolean;
  readonly expiresAt?: string;
  readonly journal?: boolean;
  readonly status?: 'reserved' | 'settlement-uncertain' | 'settled' | 'rejected';
}

// Seed a payment attempt with optional journal data and an AP2 hold
async function seed(n: number, options: Seed = {}) {
  const { mandate = true, journal = true, status = 'settlement-uncertain' } = options;
  const reference = `sha256:M${n}`;
  const reservation: PaymentAttemptReservation = {
    requestId: `req_${n}`,
    resourceId: 'resource.report',
    provider: 'x402',
    replayKey: `replay_${n}`,
    amount: '0.01',
    currency: 'USDC',
    ...(journal
      ? {
          transaction: {
            id: `txn_${n}`,
            protocol: 'http',
            configDigest: 'sha256:0',
            locator: LOCATOR,
            ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
            ...(mandate
              ? { authorization: { method: 'ap2', reference, reservationId: reference } }
              : {}),
          },
        }
      : {}),
  };
  const attempt = await store.reservePaymentAttempt(reservation);
  if (status !== 'reserved') {
    await store.updatePaymentAttempt({ replayKey: attempt.replayKey, status });
  }
  if (mandate) {
    replay.reserve({
      reference,
      checkoutJti: `checkout_${n}`,
      mandateIssuer: 'https://trusted.example',
      checkoutIssuer: 'https://merchant.example',
      resourceId: 'resource.report',
      requestId: `req_${n}`,
    });
    if (status === 'settlement-uncertain') {
      replay.markUncertain(reference);
      await store.recordTransactionStep?.({
        transactionId: `txn_${n}`,
        at: T0,
        kind: 'hold',
        hold: 'uncertain',
      });
    }
  }
  return { attempt, reference };
}

const holdOf = async (n: number) => (await store.getTransaction?.(`txn_${n}`))?.authorization?.hold;

async function reconcile(
  answers: Record<string, PaymentReconciliationResult>,
  authorizationProviders: readonly AuthorizationProvider[],
  dryRun = false,
) {
  clock.set(RUN_AT);
  return runReconcile({
    store,
    providers: [fakePayments(answers)],
    authorizationProviders,
    clock,
    actor: 'ops@example',
    dryRun,
  });
}

describe('hold alignment in reconcile', () => {
  it.each([
    ['settled', { outcome: 'settled', reason: 'transfer_final' }, 'consumed'],
    ['not-settled', { outcome: 'not-settled', reason: 'expired_unused' }, 'released'],
  ] as const)('a %s payment moves an uncertain hold to %s', async (_label, answer, hold) => {
    const { reference } = await seed(1);
    const { provider, calls } = holdProvider(replay);

    const report = await reconcile({ req_1: answer }, [provider]);

    expect(report.holds).toEqual([
      { transactionId: 'txn_1', attemptId: expect.any(String), method: 'ap2', hold, written: true },
    ]);
    expect(calls).toEqual([
      `${hold === 'consumed' ? 'consume' : 'release'} ${reference} req_1 resource.report`,
    ]);
    expect(replay.stateOf(reference)).toBe(hold);
    expect(await holdOf(1)).toBe(hold);
  });

  it('leaves consumed and released holds alone', async () => {
    await seed(1, { status: 'settled' });
    await store.recordTransactionStep?.({
      transactionId: 'txn_1',
      at: T0,
      kind: 'hold',
      hold: 'consumed',
    });
    await seed(2, { status: 'rejected' });
    await store.recordTransactionStep?.({
      transactionId: 'txn_2',
      at: T0,
      kind: 'hold',
      hold: 'released',
    });
    const { provider, calls } = holdProvider(replay);

    const report = await reconcile({}, [provider]);

    expect(report.holds).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('leaves the hold of an unresolved payment alone', async () => {
    const { reference } = await seed(1);
    const { provider, calls } = holdProvider(replay);

    const report = await reconcile({ req_1: { outcome: 'unknown', reason: 'not_final' } }, [
      provider,
    ]);

    expect(report.holds).toEqual([]);
    expect(calls).toEqual([]);
    expect(replay.stateOf(reference)).toBe('uncertain');
  });

  it('finishes a run that stopped after the attempt write, before the hold', async () => {
    const { attempt, reference } = await seed(1);
    // The earlier run resolved the attempt and stopped
    await store.resolvePaymentAttempt?.({
      attemptId: attempt.id,
      expectedStatus: 'settlement-uncertain',
      status: 'settled',
      resolution: { method: 'reconcile', actor: 'ops', reason: 'transfer_final', at: T0 },
    });
    const { provider } = holdProvider(replay);

    const report = await reconcile({}, [provider]);

    expect(report.entries).toEqual([]);
    expect(report.holds).toEqual([expect.objectContaining({ hold: 'consumed', written: true })]);
    expect(replay.stateOf(reference)).toBe('consumed');
    expect(await holdOf(1)).toBe('consumed');
  });

  it('finishes a run that stopped after the provider call, before the journal', async () => {
    const { attempt, reference } = await seed(1);
    await store.resolvePaymentAttempt?.({
      attemptId: attempt.id,
      expectedStatus: 'settlement-uncertain',
      status: 'rejected',
      resolution: { method: 'reconcile', actor: 'ops', reason: 'expired_unused', at: T0 },
    });
    replay.release(reference, 'req_1');
    const { provider } = holdProvider(replay);

    const report = await reconcile({}, [provider]);

    expect(report.holds).toEqual([expect.objectContaining({ hold: 'released', written: true })]);
    expect(replay.stateOf(reference)).toBe('released');
    expect(await holdOf(1)).toBe('released');
  });

  it('writes nothing on a second run', async () => {
    await seed(1);
    const { provider, calls } = holdProvider(replay);
    await reconcile({ req_1: { outcome: 'settled', reason: 'transfer_final' } }, [provider]);
    calls.length = 0;

    const second = await reconcile({ req_1: { outcome: 'settled', reason: 'transfer_final' } }, [
      provider,
    ]);

    expect(second).toEqual({ dryRun: false, entries: [], holds: [] });
    expect(calls).toEqual([]);
  });

  it('a dry run reports the hold and changes neither store', async () => {
    const { attempt, reference } = await seed(1);
    await store.resolvePaymentAttempt?.({
      attemptId: attempt.id,
      expectedStatus: 'settlement-uncertain',
      status: 'settled',
      resolution: { method: 'reconcile', actor: 'ops', reason: 'transfer_final', at: T0 },
    });
    const { provider, calls } = holdProvider(replay);

    const report = await reconcile({}, [provider], true);

    expect(report.holds).toEqual([expect.objectContaining({ hold: 'consumed', written: false })]);
    expect(report.holds[0]).not.toHaveProperty('reason');
    expect(calls).toEqual([]);
    expect(replay.stateOf(reference)).toBe('uncertain');
    expect(await holdOf(1)).toBe('uncertain');
  });

  it('reports a throwing provider and keeps the journal hold for the next run', async () => {
    const { reference } = await seed(1);
    const { provider } = holdProvider(replay, true);

    const report = await reconcile({ req_1: { outcome: 'settled', reason: 'transfer_final' } }, [
      provider,
    ]);

    expect(report.entries[0]?.written).toBe(true);
    expect(report.holds).toEqual([
      expect.objectContaining({ hold: 'consumed', written: false, reason: 'provider_error' }),
    ]);
    expect(replay.stateOf(reference)).toBe('uncertain');
    expect(await holdOf(1)).toBe('uncertain');
  });

  it('finds a hold past the first journal page', async () => {
    const { attempt, reference } = await seed(1);
    await store.resolvePaymentAttempt?.({
      attemptId: attempt.id,
      expectedStatus: 'settlement-uncertain',
      status: 'settled',
      resolution: { method: 'reconcile', actor: 'ops', reason: 'transfer_final', at: T0 },
    });
    // Newer rows fill the first page of 200
    for (let n = 2; n <= 201; n += 1) await seed(n, { mandate: false, status: 'settled' });
    const { provider } = holdProvider(replay);

    const report = await reconcile({}, [provider]);

    expect(report.holds).toEqual([
      expect.objectContaining({ transactionId: 'txn_1', hold: 'consumed', written: true }),
    ]);
    expect(replay.stateOf(reference)).toBe('consumed');
  });

  it('a late release does not free the mandate after another request reserved it', async () => {
    const { attempt, reference } = await seed(1, { status: 'reserved' });
    await store.updatePaymentAttempt({ replayKey: attempt.replayKey, status: 'rejected' });
    // The pipeline released the mandate and stopped before the journal write,
    // then req_9 reserved the same mandate
    replay.release(reference, 'req_1');
    replay.reserve({
      reference,
      checkoutJti: 'checkout_1',
      mandateIssuer: 'https://trusted.example',
      checkoutIssuer: 'https://merchant.example',
      resourceId: 'resource.report',
      requestId: 'req_9',
    });
    const { provider } = holdProvider(replay);

    const report = await reconcile({}, [provider]);

    expect(report.holds).toEqual([expect.objectContaining({ hold: 'released', written: true })]);
    expect(replay.stateOf(reference)).toBe('reserved');
    expect(await holdOf(1)).toBe('released');
  });
});

async function resolve(
  overrides: Partial<Parameters<typeof resolveManually>[0]> & { attemptId: string },
) {
  clock.set(RUN_AT);
  return resolveManually({
    store,
    authorizationProviders: [holdProvider(replay).provider],
    clock,
    status: 'settled',
    actor: 'alice@ops',
    reason: 'found the transfer in the explorer',
    ...overrides,
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return isCommerceError(error) ? error.code : 'not a CommerceError';
  }
  return 'no error';
}

describe('resolveManually', () => {
  it('settles an attempt with the operator reference and consumes its hold', async () => {
    const { attempt, reference } = await seed(1);

    const result = await resolve({ attemptId: attempt.id, externalReference: '0xfeed' });

    expect(result).toEqual({
      resolved: true,
      attempt: expect.objectContaining({
        id: attempt.id,
        status: 'settled',
        externalReference: '0xfeed',
        resolution: {
          method: 'manual',
          actor: 'alice@ops',
          reason: 'found the transfer in the explorer',
          at: RUN_AT,
          externalReference: '0xfeed',
        },
      }),
      hold: {
        transactionId: 'txn_1',
        attemptId: attempt.id,
        method: 'ap2',
        hold: 'consumed',
        written: true,
      },
    });
    expect(replay.stateOf(reference)).toBe('consumed');
    expect(await holdOf(1)).toBe('consumed');
    expect((await store.getTransaction?.('txn_1'))?.state).toBe('settled-undelivered');
  });

  it('settles before the recorded expiry', async () => {
    const { attempt } = await seed(1, { expiresAt: '2026-10-28T13:00:00.000Z' });

    const result = await resolve({ attemptId: attempt.id });

    expect(result.resolved).toBe(true);
  });

  it('rejects after the recorded expiry and releases the hold', async () => {
    const { attempt, reference } = await seed(1, { expiresAt: EXPIRES_AT });

    const result = await resolve({ attemptId: attempt.id, status: 'rejected' });

    expect(result).toMatchObject({
      resolved: true,
      attempt: {
        status: 'rejected',
        rejectionReason: 'not_settled',
        resolution: { method: 'manual' },
      },
      hold: { hold: 'released', written: true },
    });
    expect(replay.stateOf(reference)).toBe('released');
    expect((await store.getTransaction?.('txn_1'))?.state).toBe('payment-failed');
  });

  it('rejects at the exact expiry instant', async () => {
    const { attempt } = await seed(1, { expiresAt: RUN_AT });

    const result = await resolve({ attemptId: attempt.id, status: 'rejected' });

    expect(result.resolved).toBe(true);
  });

  it('refuses to reject before the recorded expiry, even with confirmExpired', async () => {
    const { attempt, reference } = await seed(1, { expiresAt: '2026-10-28T12:30:00.001Z' });

    const result = await resolve({
      attemptId: attempt.id,
      status: 'rejected',
      confirmExpired: true,
    });

    expect(result).toMatchObject({
      resolved: false,
      refusal: 'not_expired',
      attempt: { status: 'settlement-uncertain' },
    });
    expect((await store.getPaymentAttempt?.(attempt.id))?.resolution).toBeUndefined();
    expect(replay.stateOf(reference)).toBe('uncertain');
  });

  it.each([
    ['a journal row without an expiry', {}],
    ['an attempt written before the journal', { journal: false, mandate: false }],
  ])('refuses to reject %s unless the expiry is confirmed', async (_label, options) => {
    const { attempt } = await seed(1, options);

    const refused = await resolve({ attemptId: attempt.id, status: 'rejected' });
    expect(refused).toMatchObject({ resolved: false, refusal: 'expiry_unknown' });
    expect((await store.getPaymentAttempt?.(attempt.id))?.status).toBe('settlement-uncertain');

    const confirmed = await resolve({
      attemptId: attempt.id,
      status: 'rejected',
      confirmExpired: true,
    });
    expect(confirmed).toMatchObject({ resolved: true, attempt: { status: 'rejected' } });
  });

  it('refuses a second resolution', async () => {
    const { attempt } = await seed(1);
    await resolve({ attemptId: attempt.id });

    const second = await resolve({ attemptId: attempt.id, actor: 'bob@ops' });

    expect(second).toMatchObject({
      resolved: false,
      refusal: 'already_resolved',
      attempt: { status: 'settled', resolution: { actor: 'alice@ops' } },
    });
  });

  it('refuses when another resolver writes between the read and the update', async () => {
    const { attempt } = await seed(1);
    const racing: ReceiptStore = {
      ...store,
      async resolvePaymentAttempt(request) {
        await store.resolvePaymentAttempt?.({
          ...request,
          resolution: { method: 'reconcile', actor: 'run', reason: 'transfer_final', at: T0 },
        });
        return (await store.resolvePaymentAttempt?.(request)) ?? false;
      },
    };

    const result = await resolve({ attemptId: attempt.id, store: racing });

    expect(result).toMatchObject({
      resolved: false,
      refusal: 'already_resolved',
      attempt: { resolution: { method: 'reconcile', actor: 'run' } },
    });
  });

  it.each(['settled', 'rejected'] as const)(
    'refuses an attempt the pipeline left %s',
    async (status) => {
      const { attempt } = await seed(1, { status, mandate: false });

      const result = await resolve({ attemptId: attempt.id });

      expect(result).toMatchObject({
        resolved: false,
        refusal: 'not_resolvable',
        attempt: { status },
      });
    },
  );

  it('resolves a reserved attempt', async () => {
    const { attempt } = await seed(1, { status: 'reserved', mandate: false });

    expect(await resolve({ attemptId: attempt.id })).toMatchObject({ resolved: true });
  });

  it('reports a hold it cannot align when no authorization provider is enabled', async () => {
    const { attempt, reference } = await seed(1);

    const result = await resolve({ attemptId: attempt.id, authorizationProviders: [] });

    expect(result).toMatchObject({
      resolved: true,
      hold: { hold: 'consumed', written: false, reason: 'provider_not_enabled' },
    });
    expect(replay.stateOf(reference)).toBe('uncertain');
    expect(await holdOf(1)).toBe('uncertain');
  });

  it('returns no hold for a transaction without an authorization', async () => {
    const { attempt } = await seed(1, { mandate: false });

    const result = await resolve({ attemptId: attempt.id });

    expect(result).toEqual({
      resolved: true,
      attempt: expect.objectContaining({ status: 'settled' }),
    });
  });

  it.each([
    ['an unknown status', { status: 'refunded' }],
    ['an empty actor', { actor: '  ' }],
    ['an empty reason', { reason: '' }],
    ['an actor over 256 characters', { actor: 'a'.repeat(257) }],
    ['a reason over 1024 characters', { reason: 'r'.repeat(1025) }],
    ['a reference over 256 characters', { externalReference: '0'.repeat(257) }],
    ['an empty reference', { externalReference: '' }],
  ])('refuses %s with INPUT_INVALID and writes nothing', async (_label, overrides) => {
    const { attempt } = await seed(1);

    expect(await codeOf(() => resolve({ attemptId: attempt.id, ...overrides }))).toBe(
      'INPUT_INVALID',
    );
    expect((await store.getPaymentAttempt?.(attempt.id))?.status).toBe('settlement-uncertain');
  });

  it('accepts text at the length limits', async () => {
    const { attempt } = await seed(1);

    const result = await resolve({
      attemptId: attempt.id,
      actor: 'a'.repeat(256),
      reason: 'r'.repeat(1024),
      externalReference: '0'.repeat(256),
    });

    expect(result.resolved).toBe(true);
  });

  it('answers RESOURCE_NOT_FOUND for an unknown attempt', async () => {
    expect(await codeOf(() => resolve({ attemptId: 'pa_missing' }))).toBe('RESOURCE_NOT_FOUND');
  });
});
