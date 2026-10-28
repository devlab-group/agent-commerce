// Exercise execution IDs, journal steps and persistence failures using the
// SQLite receipt store
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CanonicalRequest,
  type Clock,
  CommerceError,
  type CommerceEvent,
  type CommerceResource,
  type DeliveredOutcome,
  type IdGenerator,
  isCommerceError,
  type PaymentProvider,
  type ReceiptStore,
  toDeliverySummary,
} from '../../src/core';
import { createExecutionPipeline } from '../../src/core/execution/pipeline';
import { createResourceRegistry } from '../../src/core/execution/registry';
import { createSqliteReceiptStore } from '../../src/storage/receipts';
import {
  createCapturingLogger,
  createFakeAuthorizationProvider,
  createFakeBackendExecutor,
  createFakeClock,
  createFakeIdGenerator,
  createFakePaymentProvider,
  type FakeAuthorizationProviderOptions,
  makeResource,
} from '../unit/core/execution/helpers';

const T0 = '2026-01-01T00:00:00.000Z';
// Default backend timeout plus the pipeline's scheduling margin
const DEADLINE = '2026-01-01T00:00:15.000Z';
const EXPIRES = '2026-01-01T00:05:00.000Z';

type JournalStore = Required<ReceiptStore>;

const PAID: CommerceResource = makeResource({
  id: 'market_report',
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  paymentMethods: ['x402'],
  exposedVia: ['http', 'mcp', 'a2a'],
});

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: 'req-1',
    resourceId: 'market_report',
    input: { city: 'Oslo' },
    protocol: 'mcp',
    receivedAt: T0,
    payment: { method: 'x402', payload: 'proof-1' },
    ...overrides,
  };
}

// Fake verifier supplying public reconciliation coordinates for the journal
function provider(
  options: Parameters<typeof createFakePaymentProvider>[0] = {},
  replayKeys: readonly string[] = ['replay-key-1'],
): PaymentProvider {
  let call = 0;
  return createFakePaymentProvider({
    verify: async () => ({
      status: 'verified',
      provider: 'x402',
      amount: '0.01',
      currency: 'USDC',
      network: 'eip155:31337',
      asset: '0xASSET',
      payer: '0xBUYER',
      payee: '0xMERCHANT',
      replayKey: replayKeys[call++] ?? `replay-key-${call}`,
      metadata: { reconciliation: { v: 1, nonce: '0xnonce', expiresAt: EXPIRES } },
    }),
    ...options,
  });
}

interface Setup {
  readonly store?: JournalStore;
  readonly resource?: CommerceResource;
  readonly payment?: PaymentProvider;
  readonly backend?: Parameters<typeof createFakeBackendExecutor>[0];
  readonly authorization?: FakeAuthorizationProviderOptions;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

function setup(options: Setup = {}) {
  const clock = options.clock ?? createFakeClock(T0);
  const store =
    options.store ?? (createSqliteReceiptStore({ path: ':memory:', clock }) as JournalStore);
  const events: CommerceEvent[] = [];
  const logger = createCapturingLogger();
  const auth =
    options.authorization !== undefined
      ? createFakeAuthorizationProvider(options.authorization)
      : undefined;
  const pipeline = createExecutionPipeline({
    resources: createResourceRegistry([options.resource ?? PAID]),
    paymentProviders: [options.payment ?? provider()],
    ...(auth !== undefined ? { authorizationProviders: [auth] } : {}),
    store,
    backend: createFakeBackendExecutor(options.backend),
    events: {
      async emit(event) {
        events.push(event);
      },
    },
    logger,
    clock,
    ids: options.ids ?? createFakeIdGenerator(),
  });
  return { pipeline, store, events, logger, auth };
}

// Fail one store method on every call, or only when the predicate matches
function failing<K extends keyof JournalStore>(
  store: JournalStore,
  method: K,
  when: (arg: never) => boolean = () => true,
): JournalStore {
  const original = store[method] as (arg: unknown) => Promise<unknown>;
  return {
    ...store,
    [method]: async (arg: never) => {
      if (when(arg)) throw new Error('disk full');
      return original(arg);
    },
  };
}

const AP2 = {
  resource: { ...PAID, authorization: { required: ['ap2'] } } as CommerceResource,
  request: request({ authorization: { method: 'ap2', payload: 'mandate-1' } }),
} as const;

const AUTHORIZATION_FLOW = provider({ requirementMetadata: { settleAfterBackend: true } });

async function rejection(promise: Promise<unknown>): Promise<CommerceError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isCommerceError(error)) throw new Error(`expected a CommerceError, got ${String(error)}`);
  return error;
}

describe('transaction ids', () => {
  it('puts one id on every event, the outcome, the receipt and the attempt of a paid call', async () => {
    const { pipeline, store, events } = setup();

    const outcome = (await pipeline.execute(request())) as DeliveredOutcome;

    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(new Set(events.map((e) => e.transactionId))).toEqual(new Set(['txn-1']));
    expect(outcome.transactionId).toBe('txn-1');
    expect(outcome.receipt.transactionId).toBe('txn-1');
    expect((await store.getReceipt(outcome.receipt.id))?.transactionId).toBe('txn-1');
    expect(await store.listPaymentAttempts()).toMatchObject([{ transactionId: 'txn-1' }]);
    expect((await store.listTransactions()).transactions.map((t) => t.id)).toEqual(['txn-1']);
  });

  it('gives a free call an id and no journal row', async () => {
    const { pipeline, store, events } = setup({
      resource: makeResource({ id: 'weather', exposedVia: ['mcp'] }),
    });

    const { payment: _none, ...free } = request({ resourceId: 'weather' });

    const outcome = (await pipeline.execute(free)) as DeliveredOutcome;

    expect(outcome).toMatchObject({ kind: 'delivered', transactionId: 'txn-1' });
    expect((await store.getReceipt(outcome.receipt.id))?.transactionId).toBe('txn-1');
    expect(new Set(events.map((e) => e.transactionId))).toEqual(new Set(['txn-1']));
    expect(await store.listTransactions()).toStrictEqual({ transactions: [] });
  });

  it('gives a payment challenge an id and no journal row', async () => {
    const { pipeline, store, events } = setup();
    const { payment: _none, ...unpaid } = request();

    const outcome = await pipeline.execute(unpaid);

    expect(outcome).toMatchObject({ kind: 'payment-required', transactionId: 'txn-1' });
    expect(new Set(events.map((e) => e.transactionId))).toEqual(new Set(['txn-1']));
    expect(await store.listTransactions()).toStrictEqual({ transactions: [] });
    expect(await store.listPaymentAttempts()).toEqual([]);
  });

  it('mints a new id for each call', async () => {
    const { pipeline, store } = setup({ payment: provider({}, ['replay-a', 'replay-b']) });

    await pipeline.execute(request());
    await pipeline.execute(request({ requestId: 'req-2' }));

    expect((await store.listTransactions()).transactions.map((t) => [t.id, t.requestId])).toEqual([
      ['txn-2', 'req-2'],
      ['txn-1', 'req-1'],
    ]);
  });
});

describe('journal steps', () => {
  it('records every fact of a delivered upfront payment', async () => {
    const { pipeline, store } = setup();

    const outcome = (await pipeline.execute(request())) as DeliveredOutcome;

    expect(await store.getTransaction('txn-1')).toStrictEqual({
      id: 'txn-1',
      requestId: 'req-1',
      resourceId: 'market_report',
      protocol: 'mcp',
      state: 'delivered',
      payment: {
        provider: 'x402',
        attemptId: (await store.listPaymentAttempts())[0]?.id,
        replayKey: 'replay-key-1',
        status: 'settled',
        amount: '0.01',
        currency: 'USDC',
        network: 'eip155:31337',
        asset: '0xASSET',
        payee: '0xMERCHANT',
        externalReference: 'tx-1',
        locator: { v: 1, nonce: '0xnonce', expiresAt: EXPIRES },
        settlingAt: T0,
        expiresAt: EXPIRES,
      },
      backend: { dispatchedAt: T0, deadlineAt: DEADLINE, status: 200 },
      receiptId: outcome.receipt.id,
      inputDigest: `sha256:${createHash('sha256').update('{"city":"Oslo"}').digest('hex')}`,
      configDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      createdAt: T0,
      updatedAt: T0,
      completedAt: T0,
    });
    expect(outcome).not.toHaveProperty('persistenceFailures');
  });

  it.each([
    ['upfront', provider(), (settling: number, dispatched: number) => settling < dispatched],
    [
      'authorization',
      AUTHORIZATION_FLOW,
      (settling: number, dispatched: number) => dispatched < settling,
    ],
  ] as const)(
    'orders settling and dispatch as the %s flow runs them',
    async (_flow, payment, ordered) => {
      // Advance now() and nowIso() by one second to expose the order of writes
      let ms = Date.parse(T0);
      const tick = () => {
        ms += 1000;
        return new Date(ms);
      };
      const ticking: Clock = {
        now: tick,
        nowIso: () => tick().toISOString(),
        monotonicMs: () => ms,
      };
      const { pipeline, store } = setup({ payment, clock: ticking });

      await pipeline.execute(request());

      const transaction = await store.getTransaction('txn-1');
      const settling = Date.parse(transaction?.payment.settlingAt ?? '');
      const dispatched = Date.parse(transaction?.backend?.dispatchedAt ?? '');
      expect(transaction?.state).toBe('delivered');
      expect(ordered(settling, dispatched)).toBe(true);
    },
  );

  it('sets the backend deadline from the resource timeout', async () => {
    const { pipeline, store } = setup({
      resource: { ...PAID, handler: { ...PAID.handler, timeoutMs: 2_000 } },
    });

    await pipeline.execute(request());

    expect((await store.getTransaction('txn-1'))?.backend?.deadlineAt).toBe(
      '2026-01-01T00:00:07.000Z',
    );
  });

  it('delivers a paid call whose input is not I-JSON and keeps no input digest for it', async () => {
    const { pipeline, store } = setup();

    // JSON.parse accepts lone surrogate escapes that canonicalJson rejects
    const outcome = await pipeline.execute(request({ input: JSON.parse('{"city":"\\ud800"}') }));

    expect(outcome.kind).toBe('delivered');
    const transaction = await store.getTransaction('txn-1');
    expect(transaction?.state).toBe('delivered');
    expect(transaction).not.toHaveProperty('inputDigest');
  });

  it('records the authorization hold and its consumption', async () => {
    const { pipeline, store } = setup({ resource: AP2.resource, authorization: {} });

    await pipeline.execute(AP2.request);

    expect((await store.getTransaction('txn-1'))?.authorization).toStrictEqual({
      method: 'ap2',
      reference: 'sha256:REFERENCE',
      metadata: { checkoutId: 'checkout-1' },
      hold: 'consumed',
      reservationId: 'reservation-1',
    });
  });

  it('leaves the hold reserved when the provider fails to consume it', async () => {
    const { pipeline, store } = setup({
      resource: AP2.resource,
      authorization: {
        consume: async () => {
          throw new Error('replay store unavailable');
        },
      },
    });

    const outcome = await pipeline.execute(AP2.request);

    expect(outcome.kind).toBe('delivered');
    expect((await store.getTransaction('txn-1'))?.authorization?.hold).toBe('reserved');
  });

  it('records a backend failure under the authorization flow: released, rejected, completed', async () => {
    const { pipeline, store, auth } = setup({
      resource: AP2.resource,
      authorization: {},
      payment: AUTHORIZATION_FLOW,
      backend: async () => {
        throw new CommerceError('BACKEND_ERROR', 'backend answered 503', {
          details: { status: 503 },
        });
      },
    });

    const error = await rejection(pipeline.execute(AP2.request));

    expect(error.code).toBe('BACKEND_ERROR');
    expect(auth?.calls).toEqual(['verifyAndReserve', 'release']);
    expect(await store.getTransaction('txn-1')).toMatchObject({
      state: 'payment-failed',
      payment: { status: 'rejected' },
      authorization: { hold: 'released' },
      backend: { status: 503, errorCode: 'BACKEND_ERROR' },
      completedAt: T0,
    });
    expect(await store.getTransaction('txn-1')).not.toHaveProperty('payment.settlingAt');
  });

  it('records a backend failure after upfront settlement: settled, undelivered receipt, completed', async () => {
    const { pipeline, store } = setup({
      backend: async () => {
        throw new CommerceError('BACKEND_ERROR', 'backend answered 502', {
          details: { status: 502 },
        });
      },
    });

    const error = await rejection(pipeline.execute(request()));

    expect(error.code).toBe('BACKEND_ERROR');
    const [receipt] = await store.listReceipts();
    expect(receipt).toMatchObject({ backendStatus: 502, transactionId: 'txn-1' });
    expect(await store.getTransaction('txn-1')).toMatchObject({
      state: 'settled-undelivered',
      payment: { status: 'settled', settlingAt: T0 },
      backend: { status: 502, errorCode: 'BACKEND_ERROR' },
      receiptId: receipt?.id,
      completedAt: T0,
    });
  });

  it('records a settlement the facilitator left pending as uncertain, with its hash', async () => {
    const { pipeline, store } = setup({
      resource: AP2.resource,
      authorization: {},
      // Match the settlement_pending error from the x402 settlement provider
      payment: provider({
        settle: async () => {
          throw new CommerceError(
            'PAYMENT_PROVIDER_UNAVAILABLE',
            'x402 provider: settlement was broadcast but could not be confirmed',
            { details: { transactionHash: '0xpending' } },
          );
        },
      }),
    });

    const error = await rejection(pipeline.execute(AP2.request));

    expect(error).toMatchObject({
      code: 'PAYMENT_SETTLEMENT_FAILED',
      details: { settlementUncertain: true, transactionHash: '0xpending' },
    });
    expect(await store.listPaymentAttempts()).toMatchObject([
      { status: 'settlement-uncertain', externalReference: '0xpending' },
    ]);
    expect(await store.getTransaction('txn-1')).toMatchObject({
      state: 'payment-uncertain',
      payment: { status: 'settlement-uncertain', externalReference: '0xpending', settlingAt: T0 },
      authorization: { hold: 'uncertain' },
      completedAt: T0,
    });
    expect(await store.getTransaction('txn-1')).not.toHaveProperty('backend');
  });

  it('records a refused settlement as failed with the hold released', async () => {
    const { pipeline, store } = setup({
      resource: AP2.resource,
      authorization: {},
      payment: provider({
        settle: async () => ({
          status: 'rejected',
          provider: 'x402',
          amount: '0.01',
          currency: 'USDC',
          rejectionReason: 'insufficient_funds',
        }),
      }),
    });

    await rejection(pipeline.execute(AP2.request));

    expect(await store.getTransaction('txn-1')).toMatchObject({
      state: 'payment-failed',
      payment: { status: 'rejected' },
      authorization: { hold: 'released' },
      completedAt: T0,
    });
  });
});

describe('a failing store write', () => {
  async function baseline() {
    const { pipeline } = setup();
    const { durationMs: _d, ...outcome } = (await pipeline.execute(request())) as DeliveredOutcome;
    return outcome;
  }

  it.each([
    [
      'payment-attempt',
      'updatePaymentAttempt',
      'Persistence failed: updatePaymentAttempt(settled)',
    ] as const,
    ['receipt', 'saveReceipt', 'Persistence failed: saveReceipt'] as const,
    [
      'journal',
      'recordTransactionStep',
      'Persistence failed: recordTransactionStep(settling)',
    ] as const,
  ])(
    'leaves the delivery unchanged when the %s write fails, and reports it in the outcome, event and log',
    async (label, method, message) => {
      const expected = await baseline();
      const clock = createFakeClock(T0);
      const store = failing(
        createSqliteReceiptStore({ path: ':memory:', clock }) as JournalStore,
        method,
      );
      const { pipeline, events, logger } = setup({ store, clock });

      const {
        durationMs: _d,
        persistenceFailures,
        ...outcome
      } = (await pipeline.execute(request())) as DeliveredOutcome;

      expect(outcome).toStrictEqual(expected);
      expect(persistenceFailures).toEqual([label]);
      expect(events.at(-1)).toMatchObject({
        type: 'resource.delivered',
        transactionId: 'txn-1',
        data: { persistenceFailures: [label] },
      });
      expect(logger.errors).toContainEqual({
        obj: expect.objectContaining({ requestId: 'req-1', transactionId: 'txn-1' }),
        msg: message,
      });
    },
  );

  it('only logs a failed completed step, which follows the outcome and the last event', async () => {
    const expected = await baseline();
    const clock = createFakeClock(T0);
    const store = failing(
      createSqliteReceiptStore({ path: ':memory:', clock }) as JournalStore,
      'recordTransactionStep',
      (step: { kind: string }) => step.kind === 'completed',
    );
    const { pipeline, events, logger } = setup({ store, clock });

    const { durationMs: _d, ...outcome } = (await pipeline.execute(request())) as DeliveredOutcome;

    expect(outcome).toStrictEqual(expected);
    expect(events.at(-1)).toMatchObject({ type: 'resource.delivered', transactionId: 'txn-1' });
    expect(events.at(-1)).not.toHaveProperty('data');
    expect(logger.errors).toContainEqual({
      obj: expect.objectContaining({ requestId: 'req-1', transactionId: 'txn-1' }),
      msg: 'Persistence failed: recordTransactionStep(completed)',
    });
    // Without completedAt, the journal still reports delivery-started before the deadline
    expect((await store.getTransaction('txn-1'))?.state).toBe('delivery-started');
  });

  it('marks the delivery summary when only the receipt failed', async () => {
    const clock = createFakeClock(T0);
    const store = failing(
      createSqliteReceiptStore({ path: ':memory:', clock }) as JournalStore,
      'saveReceipt',
    );
    const { pipeline } = setup({ store, clock });

    const outcome = (await pipeline.execute(request())) as DeliveredOutcome;

    expect(toDeliverySummary(outcome)).toMatchObject({
      receiptId: outcome.receipt.id,
      receiptCommitted: false,
    });
    expect(await store.getTransaction('txn-1')).not.toHaveProperty('receiptId');
  });

  it('reports a failed attempt write on the refusal event and keeps it out of the error', async () => {
    const clock = createFakeClock(T0);
    const store = failing(
      createSqliteReceiptStore({ path: ':memory:', clock }) as JournalStore,
      'updatePaymentAttempt',
    );
    const { pipeline, events } = setup({
      store,
      clock,
      payment: provider({
        settle: async () => ({
          status: 'rejected',
          provider: 'x402',
          amount: '0.01',
          currency: 'USDC',
          rejectionReason: 'insufficient_funds',
        }),
      }),
    });

    const error = await rejection(pipeline.execute(request()));

    expect(error).toMatchObject({ code: 'PAYMENT_SETTLEMENT_FAILED', httpStatus: 402 });
    expect(error.details).not.toHaveProperty('persistenceFailures');
    expect(events.at(-1)).toMatchObject({
      type: 'payment.rejected',
      data: { reason: 'insufficient_funds', persistenceFailures: ['payment-attempt'] },
    });
  });

  it('saves the undelivered receipt before the backend-failed event, which reports its failure', async () => {
    const clock = createFakeClock(T0);
    const store = failing(
      createSqliteReceiptStore({ path: ':memory:', clock }) as JournalStore,
      'saveReceipt',
    );
    const { pipeline, events } = setup({
      store,
      clock,
      backend: async () => {
        throw new CommerceError('BACKEND_TIMEOUT', 'backend timed out');
      },
    });

    const error = await rejection(pipeline.execute(request()));

    expect(error.code).toBe('BACKEND_ERROR');
    expect(error.details).not.toHaveProperty('persistenceFailures');
    expect(events.at(-1)).toMatchObject({
      type: 'backend.failed',
      data: { code: 'BACKEND_TIMEOUT', persistenceFailures: ['receipt'] },
    });
  });

  it('still refuses with STORAGE_ERROR and releases the hold when the journal insert fails', async () => {
    const base = createFakeIdGenerator();
    // Reuse the transaction ID so the second journal insert violates uniqueness
    const ids: IdGenerator = {
      next: (prefix) => (prefix === 'txn' ? 'txn-dup' : base.next(prefix)),
    };
    const { pipeline, store, auth } = setup({
      ids,
      resource: AP2.resource,
      authorization: {},
      payment: provider({}, ['replay-a', 'replay-b']),
    });
    await pipeline.execute(AP2.request);

    const error = await rejection(pipeline.execute({ ...AP2.request, requestId: 'req-2' }));

    expect(error.code).toBe('STORAGE_ERROR');
    expect(auth?.calls).toEqual(['verifyAndReserve', 'consume', 'verifyAndReserve', 'release']);
    expect((await store.listPaymentAttempts()).map((a) => a.replayKey)).toEqual(['replay-a']);
  });
});

it('writes no proof, mandate or input body to the database file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oac-journal-pipeline-'));
  const path = join(dir, 'receipts.sqlite');
  const markers = ['PROOF_MUST_NOT_PERSIST', 'MANDATE_MUST_NOT_PERSIST', 'INPUT_MUST_NOT_PERSIST'];
  const clock = createFakeClock(T0);
  const store = createSqliteReceiptStore({ path, clock }) as JournalStore;
  try {
    const { pipeline } = setup({ store, clock, resource: AP2.resource, authorization: {} });
    await pipeline.execute(
      request({
        input: { city: markers[2] },
        payment: { method: 'x402', payload: markers[0] as string },
        authorization: { method: 'ap2', payload: markers[1] as string },
      }),
    );
    await store.close();

    const onDisk = [path, `${path}-wal`, `${path}-shm`]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString('latin1'))
      .join('');
    // Confirm the journal data was persisted before checking for secret markers
    expect(onDisk).toContain('0xnonce');
    for (const marker of markers) expect(onDisk).not.toContain(marker);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
