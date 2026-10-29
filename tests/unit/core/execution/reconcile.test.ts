// Reconciliation candidates, conditional writes, dry runs and provider errors with SQLite
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Clock,
  Logger,
  PaymentAttemptReservation,
  PaymentProvider,
  PaymentReconciliationContext,
  PaymentReconciliationResult,
  ReceiptStore,
} from '../../../../src/core';
import { CommerceError, NOOP_LOGGER } from '../../../../src/core';
import { runReconcile } from '../../../../src/core/execution/reconcile';
import { createSqliteReceiptStore } from '../../../../src/storage/receipts';

const T0 = '2026-10-28T12:00:00.000Z';
const RUN_AT = '2026-10-28T12:30:00.000Z';
const LOCATOR = { v: 1, network: 'eip155:84532', method: 'eip3009', nonce: `0x${'ab'.repeat(32)}` };
const HASH = `0x${'cd'.repeat(32)}`;

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

function reservation(n: number, overrides: Partial<PaymentAttemptReservation> = {}) {
  return {
    requestId: `req_${n}`,
    resourceId: 'resource.report',
    provider: 'x402',
    replayKey: `replay_${n}`,
    amount: '0.01',
    currency: 'USDC',
    transaction: { id: `txn_${n}`, protocol: 'http', configDigest: 'sha256:0', locator: LOCATOR },
    ...overrides,
  } satisfies PaymentAttemptReservation;
}

// Return fixture reconciliation results by request ID
function fakeProvider(
  answers: Record<string, PaymentReconciliationResult | Error>,
  name = 'x402',
): PaymentProvider & { calls: PaymentReconciliationContext[] } {
  const calls: PaymentReconciliationContext[] = [];
  return {
    name,
    calls,
    descriptor: { name, kind: 'payment', implementationVersion: '0', supportedSpec: 'test' },
    createRequirement: vi.fn(),
    verify: vi.fn(),
    settle: vi.fn(),
    health: vi.fn(),
    async reconcile(context: PaymentReconciliationContext) {
      calls.push(context);
      const answer = answers[context.attempt.requestId] ?? { outcome: 'unknown', reason: 'unset' };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as PaymentProvider & { calls: PaymentReconciliationContext[] };
}

let clock: ReturnType<typeof stoppedClock>;
let store: ReceiptStore;

beforeEach(async () => {
  clock = stoppedClock(T0);
  store = createSqliteReceiptStore({ path: ':memory:', clock });
  await store.init();
});

afterEach(async () => {
  await store.close();
});

async function uncertain(n: number, overrides: Partial<PaymentAttemptReservation> = {}) {
  const attempt = await store.reservePaymentAttempt(reservation(n, overrides));
  await store.updatePaymentAttempt({
    replayKey: attempt.replayKey,
    status: 'settlement-uncertain',
  });
  return attempt;
}

async function run(providers: readonly PaymentProvider[], options: { dryRun?: boolean } = {}) {
  clock.set(RUN_AT);
  return runReconcile({ store, providers, clock, actor: 'ops@example', ...options });
}

describe('runReconcile writes', () => {
  it('resolves a settled attempt with the reference and evidence, and the journal follows', async () => {
    const attempt = await uncertain(1);
    const provider = fakeProvider({
      req_1: {
        outcome: 'settled',
        reason: 'transfer_final',
        externalReference: HASH,
        evidence: { blockNumber: '7' },
      },
    });

    const report = await run([provider]);

    expect(report).toEqual({
      dryRun: false,
      entries: [
        {
          attemptId: attempt.id,
          transactionId: 'txn_1',
          requestId: 'req_1',
          provider: 'x402',
          status: 'settlement-uncertain',
          outcome: 'settled',
          reason: 'transfer_final',
          written: true,
          externalReference: HASH,
        },
      ],
    });
    expect(await store.getPaymentAttempt?.(attempt.id)).toMatchObject({
      status: 'settled',
      externalReference: HASH,
      resolution: {
        method: 'reconcile',
        actor: 'ops@example',
        reason: 'transfer_final',
        at: RUN_AT,
        externalReference: HASH,
        evidence: { blockNumber: '7' },
      },
    });
    expect((await store.getTransaction?.('txn_1'))?.state).toBe('settled-undelivered');
  });

  it('rejects a not-settled attempt with reason not_settled', async () => {
    const attempt = await uncertain(1);
    const provider = fakeProvider({ req_1: { outcome: 'not-settled', reason: 'expired_unused' } });

    const [entry] = (await run([provider])).entries;

    expect(entry).toMatchObject({ outcome: 'not-settled', written: true });
    expect(await store.getPaymentAttempt?.(attempt.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'not_settled',
      resolution: { method: 'reconcile', reason: 'expired_unused', at: RUN_AT },
    });
    expect((await store.getTransaction?.('txn_1'))?.state).toBe('payment-failed');
  });

  it('writes nothing for unknown and reports the reason and retry time', async () => {
    const attempt = await uncertain(1);
    const provider = fakeProvider({
      req_1: { outcome: 'unknown', reason: 'not_expired', retryAfter: '2026-10-28T13:00:00.000Z' },
    });
    const before = await store.getPaymentAttempt?.(attempt.id);

    const [entry] = (await run([provider])).entries;

    expect(entry).toMatchObject({
      outcome: 'unknown',
      reason: 'not_expired',
      retryAfter: '2026-10-28T13:00:00.000Z',
      written: false,
    });
    expect(await store.getPaymentAttempt?.(attempt.id)).toEqual(before);
  });

  it('a dry run asks the provider and writes nothing', async () => {
    const attempt = await uncertain(1);
    const provider = fakeProvider({ req_1: { outcome: 'settled', reason: 'transfer_final' } });
    const before = await store.getPaymentAttempt?.(attempt.id);

    const report = await run([provider], { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.entries).toMatchObject([{ outcome: 'settled', written: false }]);
    expect(provider.calls).toHaveLength(1);
    expect(await store.getPaymentAttempt?.(attempt.id)).toEqual(before);
  });

  it('a second run finds no candidate once the first resolved it', async () => {
    await uncertain(1);
    const provider = fakeProvider({ req_1: { outcome: 'settled', reason: 'transfer_final' } });
    await run([provider]);

    expect((await run([provider])).entries).toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  it('resolves an old reserved attempt and a legacy failed one from their own status', async () => {
    const reserved = await store.reservePaymentAttempt(reservation(1));
    const failed = await store.reservePaymentAttempt(reservation(2));
    await store.updatePaymentAttempt({ replayKey: failed.replayKey, status: 'failed' });
    const provider = fakeProvider({
      req_1: { outcome: 'not-settled', reason: 'expired_unused' },
      req_2: { outcome: 'settled', reason: 'transfer_final' },
    });

    const report = await run([provider]);

    expect(report.entries.map(({ status, written }) => ({ status, written }))).toEqual([
      { status: 'failed', written: true },
      { status: 'reserved', written: true },
    ]);
    expect((await store.getPaymentAttempt?.(reserved.id))?.status).toBe('rejected');
    expect((await store.getPaymentAttempt?.(failed.id))?.status).toBe('settled');
  });

  it('reports not written when another resolver wins the compare-and-set', async () => {
    const attempt = await uncertain(1);
    const provider = fakeProvider({});
    provider.reconcile = async () => {
      await store.resolvePaymentAttempt?.({
        attemptId: attempt.id,
        expectedStatus: 'settlement-uncertain',
        status: 'rejected',
        resolution: { method: 'manual', actor: 'someone', reason: 'checked', at: T0 },
      });
      return { outcome: 'settled', reason: 'transfer_final' };
    };

    const [entry] = (await run([provider])).entries;

    expect(entry).toMatchObject({ outcome: 'settled', written: false });
    expect(await store.getPaymentAttempt?.(attempt.id)).toMatchObject({
      status: 'rejected',
      resolution: { method: 'manual', actor: 'someone' },
    });
  });
});

describe('runReconcile candidates', () => {
  it('passes the stored locator and the run time to the provider', async () => {
    const attempt = await uncertain(1);
    const provider = fakeProvider({});

    await run([provider]);

    expect(provider.calls).toEqual([
      { attempt: await store.getPaymentAttempt?.(attempt.id), locator: LOCATOR, now: RUN_AT },
    ]);
  });

  it('includes reserved attempts only once they reach the minimum age', async () => {
    await store.reservePaymentAttempt(reservation(1));
    clock.set('2026-10-28T12:20:00.000Z');
    await store.reservePaymentAttempt(reservation(2));
    const provider = fakeProvider({});

    // 30 and 10 minutes old at the run; the default minimum is 15 minutes
    const report = await run([provider]);

    expect(report.entries.map((entry) => entry.requestId)).toEqual(['req_1']);
  });

  it('skips settled and rejected attempts', async () => {
    const settled = await store.reservePaymentAttempt(reservation(1));
    await store.updatePaymentAttempt({ replayKey: settled.replayKey, status: 'settled' });
    const rejected = await store.reservePaymentAttempt(reservation(2));
    await store.updatePaymentAttempt({ replayKey: rejected.replayKey, status: 'rejected' });
    await uncertain(3);

    const report = await run([fakeProvider({})]);

    expect(report.entries.map((entry) => entry.requestId)).toEqual(['req_3']);
  });

  it('includes an attempt written before the journal, without a locator', async () => {
    const { transaction: _journal, ...withoutJournal } = reservation(1);
    const legacy = await store.reservePaymentAttempt(withoutJournal);
    await store.updatePaymentAttempt({ replayKey: legacy.replayKey, status: 'failed' });
    const provider = fakeProvider({});

    const report = await run([provider]);

    expect(report.entries).toMatchObject([{ attemptId: legacy.id, status: 'failed' }]);
    expect(report.entries[0]).not.toHaveProperty('transactionId');
    expect(provider.calls[0]).not.toHaveProperty('locator');
  });

  it('collects candidates across journal pages', async () => {
    for (let n = 1; n <= 205; n += 1) await uncertain(n);

    const report = await run([fakeProvider({})]);

    expect(new Set(report.entries.map((entry) => entry.attemptId)).size).toBe(205);
  });

  it('stops at the limit, newest first', async () => {
    for (let n = 1; n <= 3; n += 1) await uncertain(n);

    const report = await runReconcile({
      store,
      providers: [fakeProvider({})],
      clock,
      actor: 'ops',
      limit: 2,
    });

    expect(report.entries.map((entry) => entry.requestId)).toEqual(['req_3', 'req_2']);
  });

  it('counts attempts written before the journal toward the limit', async () => {
    await uncertain(1);
    for (const n of [2, 3]) {
      const { transaction: _journal, ...withoutJournal } = reservation(n);
      const legacy = await store.reservePaymentAttempt(withoutJournal);
      await store.updatePaymentAttempt({ replayKey: legacy.replayKey, status: 'failed' });
    }

    const report = await runReconcile({
      store,
      providers: [fakeProvider({})],
      clock,
      actor: 'ops',
      limit: 2,
    });

    expect(report.entries.map((entry) => entry.requestId)).toEqual(['req_1', 'req_3']);
  });
});

describe('runReconcile provider answers', () => {
  it('answers unknown when the provider is not enabled or cannot reconcile', async () => {
    await uncertain(1);
    await uncertain(2, { provider: 'mpp' });
    const { reconcile: _reconcile, ...mpp } = fakeProvider({}, 'mpp');

    const report = await run([mpp]);

    expect(
      report.entries.map(({ provider, outcome, reason }) => ({ provider, outcome, reason })),
    ).toEqual([
      { provider: 'mpp', outcome: 'unknown', reason: 'reconcile_unsupported' },
      { provider: 'x402', outcome: 'unknown', reason: 'provider_not_enabled' },
    ]);
  });

  it('answers unknown for a throwing provider and logs the error without its URL path', async () => {
    const attempt = await uncertain(1);
    const warn = vi.fn();
    const logger: Logger = { ...NOOP_LOGGER, warn };
    const provider = fakeProvider({
      req_1: new Error('fetch failed for https://rpc.example/v2/secret-key'),
    });

    clock.set(RUN_AT);
    const report = await runReconcile({
      store,
      providers: [provider],
      clock,
      actor: 'ops',
      logger,
    });

    expect(report.entries).toMatchObject([{ outcome: 'unknown', reason: 'provider_error' }]);
    expect(warn).toHaveBeenCalledWith(
      {
        attemptId: attempt.id,
        provider: 'x402',
        err: 'Error: fetch failed for https://rpc.example',
      },
      'reconcile: provider threw',
    );
  });

  it('answers unknown for a result outside the contract and writes nothing', async () => {
    const attempt = await uncertain(1);
    const provider = fakeProvider({
      req_1: { outcome: 'refunded', reason: 'x' } as unknown as PaymentReconciliationResult,
    });

    const report = await run([provider]);

    expect(report.entries).toMatchObject([
      { outcome: 'unknown', reason: 'invalid_provider_result', written: false },
    ]);
    expect((await store.getPaymentAttempt?.(attempt.id))?.status).toBe('settlement-uncertain');
  });

  it('refuses a store without journal methods', async () => {
    const { listTransactions: _list, ...legacyStore } = store;

    await expect(
      runReconcile({ store: legacyStore, providers: [], clock, actor: 'ops' }),
    ).rejects.toThrow(CommerceError);
    await expect(
      runReconcile({ store: legacyStore, providers: [], clock, actor: 'ops' }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });
});
