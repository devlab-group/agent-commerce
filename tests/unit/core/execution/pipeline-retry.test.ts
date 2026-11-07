/**
 * Exercise retry claims, expiry and reclaim with SQLite. A counting fake
 * provider uses `payer/nonce` proofs: `forged` is rejected, and `anon` verifies
 * without a payer.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommerceEvent } from '../../../../src/core/domain/event';
import type { PaymentProvider } from '../../../../src/core/domain/payment';
import type { CanonicalRequest, DeliveredOutcome } from '../../../../src/core/domain/request';
import type { CommerceResource } from '../../../../src/core/domain/resource';
import { toErrorEnvelope } from '../../../../src/core/domain/wire';
import { CommerceError, isCommerceError } from '../../../../src/core/errors';
import { createExecutionPipeline } from '../../../../src/core/execution/pipeline';
import { assertRetrySupport } from '../../../../src/core/execution/pipeline/retry';
import { createResourceRegistry } from '../../../../src/core/execution/registry';
import type { BackendRequest, BackendResponse } from '../../../../src/core/interfaces/backend';
import type { Logger } from '../../../../src/core/interfaces/logger';
import type { Clock } from '../../../../src/core/interfaces/runtime';
import {
  createSqliteReceiptStore,
  type SqliteReceiptStore,
} from '../../../../src/storage/receipts';
import {
  createFakeAuthorizationProvider,
  createFakeBackendExecutor,
  createFakeIdGenerator,
  createFakePaymentProvider,
  createFakeStore,
  makeResource,
} from './helpers';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR_MS = 3_600_000;
const CLIENT_KEY = 'client-key-secret-1';
const DEPLOYMENT = 'https://gw.example';

// sha256sum of {}, the digest the claim is fingerprinted with
const EMPTY_INPUT_DIGEST =
  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const SCOPE = {
  deployment: DEPLOYMENT,
  endpoint: 'payment:res-1',
  key: createHash('sha256').update(CLIENT_KEY).digest('hex'),
};
// sha256sum of ["paid-operation","https://gw.example","res-1","<identity>","sha256:<digest of {}>"]
const MERCHANT_KEY_FOR_CLIENT_KEY =
  '2b380ff0fa31f524434675ac86f733173bd62bfa65b0659a194e2f3c7f2f4bde';
const MERCHANT_KEY_FOR_PROOF = '387ea77166eb841a04f939e2239e0142ead5cc2aa30d27e9e63999c01ff4b5fa';
const MERCHANT_KEY_FOR_ANON_PROOF =
  'c60d2bf5d522d82f49c16d5e6771ae799127a6ed083dd3c3c2dd0bc130024b6f';
// sha256sum of x402:alice/1
const PROOF_DIGEST = '847918077efb9a729f6444e770b7b22a980d287fff7fa938dc5814f119fff09b';
const proofDigest = (payload: string) =>
  createHash('sha256').update(`x402:${payload}`).digest('hex');

const REDELIVERY = { redelivery: { retentionHours: 24, required: false } };
const OPTED_IN: Partial<CommerceResource> = {
  id: 'res-1',
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  paymentMethods: ['x402'],
  idempotency: REDELIVERY,
};

const stores: SqliteReceiptStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function movableClock(): Clock & { advance(ms: number): void } {
  let at = T0;
  let tick = 0;
  return {
    now: () => new Date(at),
    nowIso: () => new Date(at).toISOString(),
    monotonicMs: () => {
      tick += 1;
      return tick;
    },
    advance(ms) {
      at += ms;
    },
  };
}

function recordingLogger(): Logger & { lines: unknown[] } {
  const lines: unknown[] = [];
  const log = (obj: unknown, msg?: string) => {
    lines.push([obj, msg]);
  };
  const logger: Logger & { lines: unknown[] } = {
    lines,
    debug: log,
    info: log,
    warn: log,
    error: log,
    child: () => logger,
  };
  return logger;
}

interface Setup {
  readonly resource?: Partial<CommerceResource>;
  readonly settleAfterBackend?: boolean;
  readonly provider?: Partial<PaymentProvider>;
  readonly backend?: (request: BackendRequest) => Promise<BackendResponse>;
  readonly path?: string;
  readonly authorization?: boolean;
  readonly verifyBarrier?: Promise<void>;
}

function setup(options: Setup = {}) {
  const clock = movableClock();
  const store = createSqliteReceiptStore({ path: options.path ?? ':memory:', clock });
  stores.push(store);
  const calls = { createRequirement: 0, verify: 0, settle: 0, backend: 0, ap2: 0 };
  const sent: BackendRequest[] = [];
  const events: CommerceEvent[] = [];
  const logger = recordingLogger();
  const auth = createFakeAuthorizationProvider();
  const verifyAndReserve = auth.verifyAndReserve.bind(auth);
  auth.verifyAndReserve = (ctx) => {
    calls.ap2 += 1;
    return verifyAndReserve(ctx);
  };
  const base = createFakePaymentProvider({
    ...(options.settleAfterBackend ? { requirementMetadata: { settleAfterBackend: true } } : {}),
  });
  const provider: PaymentProvider = {
    ...base,
    createRequirement: (ctx) => {
      calls.createRequirement += 1;
      return base.createRequirement(ctx);
    },
    verify: async ({ submission }) => {
      calls.verify += 1;
      await options.verifyBarrier;
      const [payer] = submission.payload.split('/');
      const amounts = { provider: 'x402', amount: '0.01', currency: 'USDC' } as const;
      if (payer === 'forged') {
        return { status: 'rejected', ...amounts, rejectionReason: 'invalid_signature' };
      }
      return {
        status: 'verified',
        ...amounts,
        ...(payer !== 'anon' ? { payer } : {}),
        replayKey: `replay-${submission.payload}`,
      };
    },
    settle: async ({ verification }) => {
      calls.settle += 1;
      return {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        // A fee payer, unlike the buyer that verification names
        payer: 'fee-payer',
        externalReference: `tx-${calls.settle}`,
        metadata: { receipt: 'mpp-receipt', amountBaseUnits: '10000', from: verification.payer },
      };
    },
    ...options.provider,
  };
  const pipeline = createExecutionPipeline({
    resources: createResourceRegistry([makeResource({ ...OPTED_IN, ...options.resource })]),
    paymentProviders: [provider],
    authorizationProviders: options.authorization ? [auth] : [],
    store,
    backend: createFakeBackendExecutor(async (_handler, request) => {
      calls.backend += 1;
      sent.push(request);
      if (options.backend) return options.backend(request);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { report: 'paid data' },
        durationMs: 5,
      };
    }),
    events: {
      async emit(event) {
        events.push(event);
      },
    },
    logger,
    clock,
    ids: createFakeIdGenerator(),
    deployment: DEPLOYMENT,
  });
  return { pipeline, store, calls, sent, events, logger, clock };
}

let requestCounter = 0;

function paid(payload = 'alice/1', overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  requestCounter += 1;
  return {
    requestId: `req-${requestCounter}`,
    resourceId: 'res-1',
    input: {},
    protocol: 'http',
    receivedAt: '2026-01-01T00:00:00.000Z',
    payment: { method: 'x402', payload },
    retryKey: CLIENT_KEY,
    ...overrides,
  };
}

async function delivered(run: Promise<unknown>): Promise<DeliveredOutcome> {
  const outcome = (await run) as DeliveredOutcome;
  expect(outcome.kind).toBe('delivered');
  return outcome;
}

async function refusal(run: Promise<unknown>): Promise<CommerceError> {
  const error = await run.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (isCommerceError(error)) return error;
  return expect.unreachable(`expected a CommerceError, got ${String(error)}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const row = (store: SqliteReceiptStore) => store.getIdempotencyKey(SCOPE, EMPTY_INPUT_DIGEST);

describe('retry gate: requests it leaves alone', () => {
  it('claims nothing for a request with no client key', async () => {
    const { pipeline, store, calls } = setup();

    await delivered(pipeline.execute(paid('alice/1', { retryKey: undefined as never })));

    expect(calls.settle).toBe(1);
    expect(await row(store)).toBeUndefined();
  });

  it('claims nothing on a resource that did not opt in', async () => {
    const { pipeline, store, calls } = setup({ resource: { idempotency: undefined as never } });

    await delivered(pipeline.execute(paid()));
    await delivered(pipeline.execute(paid('alice/2')));

    expect(calls.settle).toBe(2);
    expect(await row(store)).toBeUndefined();
  });

  it('answers a request with no proof with a challenge, and claims nothing', async () => {
    const { pipeline, store } = setup();

    const outcome = await pipeline.execute(paid('x', { payment: undefined as never }));

    expect(outcome.kind).toBe('payment-required');
    expect(await row(store)).toBeUndefined();
  });

  it("reads the provider's key from the proof when the request has none", async () => {
    const retryKey: NonNullable<PaymentProvider['retryKey']> = () => CLIENT_KEY;
    const { pipeline, store } = setup({ provider: { retryKey } });

    await delivered(pipeline.execute(paid('alice/1', { retryKey: undefined as never })));

    expect((await row(store))?.kind).toBe('replay');
  });

  it('prefers the request key over the provider key', async () => {
    const retryKey: NonNullable<PaymentProvider['retryKey']> = () => 'another-key';
    const { pipeline, store } = setup({ provider: { retryKey } });

    await delivered(pipeline.execute(paid()));

    expect((await row(store))?.kind).toBe('replay');
  });

  it('does not read a key on a resource that did not opt in', async () => {
    let read = 0;
    const retryKey: NonNullable<PaymentProvider['retryKey']> = () => {
      read += 1;
      return CLIENT_KEY;
    };
    const { pipeline } = setup({
      resource: { idempotency: undefined as never },
      provider: { retryKey },
    });

    await delivered(pipeline.execute(paid()));

    expect(read).toBe(0);
  });

  it("passes a provider's refusal of a bad key through before any payment work", async () => {
    const retryKey: NonNullable<PaymentProvider['retryKey']> = () => {
      throw new CommerceError('INPUT_INVALID', 'bad key', {
        details: { reason: 'payment_identifier_invalid' },
      });
    };
    const { pipeline, calls, events } = setup({ provider: { retryKey } });
    const request = paid('alice/1', { retryKey: undefined as never });

    const error = await refusal(pipeline.execute(request));

    expect(error).toMatchObject({
      code: 'INPUT_INVALID',
      requestId: request.requestId,
      resourceId: 'res-1',
    });
    expect(error.details?.['reason']).toBe('payment_identifier_invalid');
    expect(calls.createRequirement).toBe(0);
    const rejected = events.filter((event) => event.type === 'payment.rejected');
    expect(rejected.map((event) => event.data)).toEqual([{ reason: 'payment_identifier_invalid' }]);
  });

  it("reports a provider's untyped key failure as the provider's, before any payment work", async () => {
    const retryKey: NonNullable<PaymentProvider['retryKey']> = () => {
      throw new Error('decoder bug');
    };
    const { pipeline, calls } = setup({ provider: { retryKey } });
    const request = paid('alice/1', { retryKey: undefined as never });

    const error = await refusal(pipeline.execute(request));

    expect(error).toMatchObject({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      requestId: request.requestId,
    });
    expect(error.message).not.toContain('decoder bug');
    expect(calls.createRequirement).toBe(0);
  });

  it('refuses input that is not I-JSON before any payment work', async () => {
    const { pipeline, calls, store, events } = setup();
    const request = paid('alice/1', { input: { text: '\uD800' } });

    const error = await refusal(pipeline.execute(request));

    expect(error).toMatchObject({ code: 'INPUT_INVALID', requestId: request.requestId });
    expect(calls).toMatchObject({ createRequirement: 0, verify: 0, settle: 0 });
    expect(await store.countReceipts()).toBe(0);
    expect(events.find((event) => event.type === 'payment.rejected')?.data).toEqual({
      reason: 'INPUT_INVALID',
    });
  });
});

describe.each([
  ['upfront', false],
  ['authorization', true],
])('retry gate: a retry after a lost response, %s flow', (_name, settleAfterBackend) => {
  it('serves an exact resend with no provider, AP2 or backend call', async () => {
    const { pipeline, calls } = setup({
      settleAfterBackend,
      authorization: true,
      resource: { authorization: { required: ['ap2'] } },
    });
    const authorization = { method: 'ap2', payload: 'mandate' } as const;
    const first = await delivered(pipeline.execute(paid('alice/1', { authorization })));
    const before = { ...calls };

    const again = await delivered(pipeline.execute(paid('alice/1', { authorization })));

    expect(calls).toEqual(before);
    expect(calls.settle).toBe(1);
    expect(again.redelivered).toBe(true);
    expect(again.body).toEqual(first.body);
  });

  it('serves a fresh proof from the same payer, verifying it with no AP2 or settle', async () => {
    const { pipeline, calls } = setup({
      settleAfterBackend,
      authorization: true,
      resource: { authorization: { required: ['ap2'] } },
    });
    const authorization = { method: 'ap2', payload: 'mandate' } as const;
    const first = await delivered(pipeline.execute(paid('alice/1', { authorization })));
    const before = { ...calls };

    const again = await delivered(pipeline.execute(paid('alice/2', { authorization })));

    expect(calls).toEqual({
      ...before,
      createRequirement: before.createRequirement + 1,
      verify: before.verify + 1,
    });
    expect(again.redelivered).toBe(true);
    expect(again.body).toEqual(first.body);
  });

  it.each([
    ['an exact resend without the mandate', 'alice/1', undefined],
    ['a fresh proof without the mandate', 'alice/2', undefined],
    ['a fresh proof with another mandate', 'alice/2', 'other-mandate'],
  ])('refuses %s the purchase used, serving nothing', async (_name, payload, mandate) => {
    const { pipeline, calls } = setup({
      settleAfterBackend,
      authorization: true,
      resource: { authorization: { required: ['ap2'] } },
    });
    await delivered(
      pipeline.execute(paid('alice/1', { authorization: { method: 'ap2', payload: 'mandate' } })),
    );
    const before = { ...calls };
    const retried = paid(payload, {
      ...(mandate !== undefined ? { authorization: { method: 'ap2', payload: mandate } } : {}),
    });

    const error = await refusal(pipeline.execute(retried));

    // The fake accepts the spent proof to exercise retry conflict handling
    expect(error).toMatchObject({ code: 'PAYMENT_REPLAYED', httpStatus: 409 });
    expect(error.details).toEqual({ reason: 'payment_identifier_conflict' });
    expect(JSON.stringify(toErrorEnvelope(error))).not.toContain('paid data');
    expect(calls).toMatchObject({
      settle: before.settle,
      backend: before.backend,
      ap2: before.ap2,
    });
  });

  it.each([
    ['an exact resend without a mandate', 'alice/1', false],
    ['a fresh proof with a mandate', 'alice/2', true],
  ])(
    'serves %s nothing once the resource requires a mandate it did not when it paid',
    async (_name, payload, withMandate) => {
      const path = join(mkdtempSync(join(tmpdir(), 'retry-gate-')), 'receipts.sqlite');
      const before = setup({ settleAfterBackend, path });
      await delivered(before.pipeline.execute(paid()));
      const after = setup({
        settleAfterBackend,
        path,
        authorization: true,
        resource: { authorization: { required: ['ap2'] } },
      });
      const authorization = { method: 'ap2', payload: 'mandate' } as const;
      const retried = paid(payload, withMandate ? { authorization } : {});

      const error = await refusal(after.pipeline.execute(retried));

      // The fake accepts the spent proof to exercise retry conflict handling
      expect(error.details).toEqual({ reason: 'payment_identifier_conflict' });
      expect(after.calls).toMatchObject({ settle: 0, backend: 0 });
    },
  );

  it('rebuilds the original outcome, apart from the request and transaction ids and duration', async () => {
    const { pipeline } = setup({
      settleAfterBackend,
      backend: async () => ({
        status: 201,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'created',
        durationMs: 5,
      }),
    });
    const first = await delivered(pipeline.execute(paid()));
    const request = paid('alice/2');

    const again = await delivered(pipeline.execute(request));

    expect(again).toEqual({
      ...first,
      requestId: request.requestId,
      transactionId: again.transactionId,
      durationMs: again.durationMs,
      redelivered: true,
    });
    expect(again.transactionId).toEqual(expect.any(String));
    expect(again.transactionId).not.toBe(first.transactionId);
    expect(again.receipt.transactionId).toBe(first.transactionId);
    expect(again.payment?.metadata).toMatchObject({
      receipt: 'mpp-receipt',
      amountBaseUnits: '10000',
    });
    expect(first).not.toHaveProperty('redelivered');
  });

  it('writes no receipt, attempt or journal row', async () => {
    const { pipeline, store } = setup({ settleAfterBackend });
    await delivered(pipeline.execute(paid()));

    await delivered(pipeline.execute(paid()));
    await delivered(pipeline.execute(paid('alice/2')));

    expect(await store.countReceipts()).toBe(1);
    expect(await store.listPaymentAttempts()).toHaveLength(1);
    expect((await store.listTransactions({})).transactions).toHaveLength(1);
  });

  it('reports the redelivery on a delivered event, with no settlement event', async () => {
    const { pipeline, events } = setup({ settleAfterBackend });
    const first = await delivered(pipeline.execute(paid()));
    events.length = 0;

    const again = await delivered(pipeline.execute(paid()));

    expect(events.map((event) => event.type)).toEqual(['resource.requested', 'resource.delivered']);
    expect(events[1]?.data).toEqual({
      redelivered: true,
      originalTransactionId: first.transactionId,
    });
    // Redelivery uses a new transaction ID; event data keeps the purchase ID
    expect(events.map((event) => event.transactionId)).toEqual([
      again.transactionId,
      again.transactionId,
    ]);
  });

  it('refuses another payer, with no stored body in the error', async () => {
    const { pipeline, store, calls } = setup({ settleAfterBackend });
    await delivered(pipeline.execute(paid()));

    const error = await refusal(pipeline.execute(paid('mallory/1')));

    expect(error).toMatchObject({ code: 'PAYMENT_REPLAYED', httpStatus: 409 });
    expect(error.details).toEqual({ reason: 'payment_identifier_conflict' });
    expect(JSON.stringify(toErrorEnvelope(error))).not.toContain('paid data');
    expect(calls.settle).toBe(1);
    expect((await row(store))?.kind).toBe('replay');
  });

  it('refuses a verified proof with an unknown payer', async () => {
    const { pipeline, store, calls } = setup({ settleAfterBackend });
    await delivered(pipeline.execute(paid()));

    const error = await refusal(pipeline.execute(paid('anon/1')));

    expect(error.details).toEqual({ reason: 'payment_identifier_conflict' });
    expect(calls.settle).toBe(1);
    expect((await row(store))?.kind).toBe('replay');
  });

  it('gives a forged proof with a known key the normal refusal', async () => {
    const { pipeline, store, calls } = setup({ settleAfterBackend });
    await delivered(pipeline.execute(paid()));

    const error = await refusal(pipeline.execute(paid('forged/1')));

    expect(error.code).toBe('PAYMENT_INVALID');
    expect(JSON.stringify(toErrorEnvelope(error))).not.toContain('paid data');
    expect(calls.settle).toBe(1);
    expect((await row(store))?.kind).toBe('replay');
  });

  it('refuses the same key with other input once the proof verifies, settling nothing', async () => {
    const { pipeline, calls } = setup({ settleAfterBackend });
    await delivered(pipeline.execute(paid()));
    const before = { ...calls };

    const error = await refusal(pipeline.execute(paid('alice/2', { input: { city: 'Oslo' } })));

    expect(error).toMatchObject({ code: 'PAYMENT_REPLAYED', httpStatus: 409 });
    expect(error.details).toEqual({ reason: 'payment_identifier_conflict' });
    expect(calls).toEqual({
      ...before,
      createRequirement: before.createRequirement + 1,
      verify: before.verify + 1,
    });
  });

  it('tells a junk proof with a used key and other input nothing about the key', async () => {
    const { pipeline, calls } = setup({ settleAfterBackend });
    await delivered(pipeline.execute(paid()));

    const error = await refusal(pipeline.execute(paid('forged/1', { input: { city: 'Oslo' } })));

    expect(error.code).toBe('PAYMENT_INVALID');
    expect(error.details?.['reason']).toBe('invalid_signature');
    expect(calls.settle).toBe(1);
  });
});

describe('retry gate: a purchase whose payer is unknown', () => {
  it('still serves an exact resend', async () => {
    const { pipeline, calls } = setup();
    await delivered(pipeline.execute(paid('anon/1')));

    const again = await delivered(pipeline.execute(paid('anon/1')));

    expect(again.redelivered).toBe(true);
    expect(calls.settle).toBe(1);
  });

  it('refuses a fresh proof, which no stored payer can match', async () => {
    const { pipeline, calls } = setup();
    await delivered(pipeline.execute(paid('anon/1')));

    const error = await refusal(pipeline.execute(paid('anon/2')));

    expect(error.details).toEqual({ reason: 'payment_identifier_conflict' });
    expect(calls.settle).toBe(1);
  });

  it('refuses a named payer too', async () => {
    const { pipeline, calls } = setup();
    await delivered(pipeline.execute(paid('anon/1')));

    const error = await refusal(pipeline.execute(paid('alice/1')));

    expect(error.details).toEqual({ reason: 'payment_identifier_conflict' });
    expect(calls.settle).toBe(1);
  });
});

describe('retry gate: an unresolved or concurrent key', () => {
  it('lets one of two concurrent requests settle after the other is in flight', async () => {
    const settling = deferred();
    const entered = deferred();
    let settles = 0;
    const { pipeline, calls } = setup({
      provider: {
        settle: async () => {
          settles += 1;
          entered.resolve();
          await settling.promise;
          return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
        },
      },
    });

    const first = pipeline.execute(paid());
    await entered.promise;
    const before = { ...calls };
    const error = await refusal(pipeline.execute(paid('alice/2')));
    settling.resolve();
    await delivered(first);

    expect(error).toMatchObject({ code: 'PAYMENT_REPLAYED', httpStatus: 409, retryable: true });
    expect(error.details).toEqual({
      reason: 'payment_identifier_in_flight',
      retryAfterSeconds: 1,
    });
    expect(calls.verify).toBe(before.verify + 1);
    expect(settles).toBe(1);
  });

  it('refuses an exact resend of an in-flight purchase before verifying it', async () => {
    const settling = deferred();
    const entered = deferred();
    const { pipeline, calls } = setup({
      provider: {
        settle: async () => {
          entered.resolve();
          await settling.promise;
          return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
        },
      },
    });

    const first = pipeline.execute(paid());
    await entered.promise;
    const before = { ...calls };
    const error = await refusal(pipeline.execute(paid()));
    const after = { ...calls };
    settling.resolve();
    await delivered(first);

    expect(error).toMatchObject({ retryable: true });
    expect(error.details?.['reason']).toBe('payment_identifier_in_flight');
    expect(after).toEqual(before);
  });

  it('tells a junk proof nothing about an in-flight key', async () => {
    const settling = deferred();
    const entered = deferred();
    const { pipeline } = setup({
      provider: {
        settle: async () => {
          entered.resolve();
          await settling.promise;
          return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
        },
      },
    });

    const first = pipeline.execute(paid());
    await entered.promise;
    const sameInput = await refusal(pipeline.execute(paid('forged/1')));
    const otherInput = await refusal(pipeline.execute(paid('forged/2', { input: { a: 1 } })));
    settling.resolve();
    await delivered(first);

    for (const error of [sameInput, otherInput]) {
      expect(error.code).toBe('PAYMENT_INVALID');
      expect(error.details?.['reason']).toBe('invalid_signature');
    }
  });

  it('lets one settle when both pass the read before either claims', async () => {
    const barrier = deferred();
    const { pipeline, calls } = setup({ verifyBarrier: barrier.promise });

    const runs = [pipeline.execute(paid()), pipeline.execute(paid('alice/2'))].map((run) =>
      run.then(
        () => 'delivered',
        (error: CommerceError) => error.details?.['reason'],
      ),
    );
    await expect.poll(() => calls.verify).toBe(2);
    barrier.resolve();

    expect((await Promise.all(runs)).sort()).toEqual(['delivered', 'payment_identifier_in_flight']);
    expect(calls.settle).toBe(1);
  });

  it('leaves the claim with the request that won it', async () => {
    const barrier = deferred();
    const settling = deferred();
    const { pipeline, store, calls } = setup({
      verifyBarrier: barrier.promise,
      provider: {
        settle: async () => {
          await settling.promise;
          return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
        },
      },
    });
    const runs = [pipeline.execute(paid()), pipeline.execute(paid('alice/2'))].map((run) =>
      run.catch((error: unknown) => error),
    );
    await expect.poll(() => calls.verify).toBe(2);
    barrier.resolve();

    const lost = await Promise.race(runs);
    const during = await row(store);
    settling.resolve();
    const results = await Promise.all(runs);
    const won = results.findIndex((result) => (result as DeliveredOutcome).kind === 'delivered');

    expect(lost).toMatchObject({ details: { reason: 'payment_identifier_in_flight' } });
    expect(during).toEqual({
      kind: 'in-flight',
      owner: proofDigest(won === 0 ? 'alice/1' : 'alice/2'),
    });
    expect((await row(store))?.kind).toBe('replay');
  });

  it('answers an unresolved key with 409 and no challenge, verifying only a fresh proof', async () => {
    const { pipeline, calls } = setup({
      settleAfterBackend: true,
      provider: {
        settle: async () => {
          throw new Error('facilitator lost the response');
        },
      },
    });
    await refusal(pipeline.execute(paid()));
    const before = { ...calls };

    const resend = await refusal(pipeline.execute(paid()));
    const afterResend = { ...calls };
    const fresh = await refusal(pipeline.execute(paid('alice/2')));

    for (const error of [resend, fresh]) {
      expect(error).toMatchObject({ code: 'PAYMENT_REPLAYED', httpStatus: 409, retryable: false });
      expect(error.details).toEqual({ reason: 'payment_identifier_unresolved' });
    }
    expect(afterResend).toEqual(before);
    expect(calls).toEqual({
      ...before,
      createRequirement: before.createRequirement + 1,
      verify: before.verify + 1,
    });
  });

  it('tells a junk proof nothing about an unresolved key', async () => {
    const { pipeline, store } = setup({
      provider: {
        settle: async () => {
          throw new Error('facilitator lost the response');
        },
      },
    });
    await refusal(pipeline.execute(paid()));

    const error = await refusal(pipeline.execute(paid('forged/1')));

    expect(error.code).toBe('PAYMENT_INVALID');
    expect(error.details?.['reason']).toBe('invalid_signature');
    expect((await row(store))?.kind).toBe('unresolved');
  });

  it('marks every refusal as a rejected payment, by reason', async () => {
    const { pipeline, events } = setup();
    await delivered(pipeline.execute(paid()));
    events.length = 0;

    await refusal(pipeline.execute(paid('mallory/1')));

    const rejected = events.filter((event) => event.type === 'payment.rejected');
    expect(rejected.map((event) => event.data)).toEqual([
      { reason: 'payment_identifier_conflict' },
    ]);
  });

  it('keeps a spent proof under a new key refused, and frees the new key', async () => {
    const { pipeline, store, calls } = setup();
    await delivered(pipeline.execute(paid('alice/1', { retryKey: 'another-key-1' })));

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('PAYMENT_REPLAYED');
    expect(calls.settle).toBe(1);
    expect(await row(store)).toBeUndefined();
  });

  it('writes nothing for a junk proof', async () => {
    const { pipeline, store } = setup();

    const error = await refusal(pipeline.execute(paid('forged/1')));

    expect(error.code).toBe('PAYMENT_INVALID');
    expect(await row(store)).toBeUndefined();
  });

  it('writes nothing for a proof whose verification throws', async () => {
    const { pipeline, store } = setup({
      provider: {
        verify: async () => {
          throw new Error('facilitator down');
        },
      },
    });

    await refusal(pipeline.execute(paid()));

    expect(await row(store)).toBeUndefined();
  });

  it('writes nothing for a verified proof with no replay key', async () => {
    const { pipeline, store } = setup({
      provider: {
        verify: async () => ({
          status: 'verified',
          provider: 'x402',
          amount: '0.01',
          currency: 'USDC',
        }),
      },
    });

    await refusal(pipeline.execute(paid()));

    expect(await row(store)).toBeUndefined();
  });
});

describe('retry gate: secrets and stored data', () => {
  it('puts no client key or proof in a log line, an event or an error', async () => {
    const failing = setup({
      settleAfterBackend: true,
      provider: {
        settle: async () => {
          throw new Error('lost');
        },
      },
    });
    failing.store.saveReceipt = async () => {
      throw new Error('disk full');
    };
    const errors = [
      await refusal(failing.pipeline.execute(paid())),
      await refusal(failing.pipeline.execute(paid())),
    ];
    const { pipeline, events, logger } = setup();
    await delivered(pipeline.execute(paid()));
    await delivered(pipeline.execute(paid()));
    await delivered(pipeline.execute(paid('alice/2')));
    errors.push(await refusal(pipeline.execute(paid('mallory/1'))));

    const seen = JSON.stringify([
      events,
      logger.lines,
      failing.events,
      failing.logger.lines,
      errors.map(toErrorEnvelope),
    ]);

    expect(seen).not.toContain(CLIENT_KEY);
    expect(seen).not.toContain('alice/1');
    expect(seen).not.toContain('mallory/1');
    expect(seen).not.toContain(PROOF_DIGEST);
  });

  it('never sends the client key to the merchant', async () => {
    const { pipeline, sent } = setup({
      resource: { idempotency: { merchantKey: true, ...REDELIVERY } },
    });

    await delivered(pipeline.execute(paid()));

    expect(JSON.stringify(sent)).not.toContain(CLIENT_KEY);
  });

  it('stores only the content type of the backend headers', async () => {
    const { pipeline, store } = setup({
      backend: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': 'session=secret' },
        body: '<p>paid</p>',
        durationMs: 5,
      }),
    });

    const first = await delivered(pipeline.execute(paid()));
    const again = await delivered(pipeline.execute(paid()));

    expect(await row(store)).toEqual({
      kind: 'replay',
      status: 200,
      body: {
        proofDigest: PROOF_DIGEST,
        // The buyer verification named, not the fee payer settlement reported
        payer: 'alice',
        contentType: 'text/html',
        body: '<p>paid</p>',
        receiptId: first.receipt.id,
      },
    });
    expect(again.headers).toEqual({ 'content-type': 'text/html' });
  });

  it('keeps a response with no content type and an empty body', async () => {
    const { pipeline } = setup({
      backend: async () => ({ status: 204, headers: {}, body: undefined, durationMs: 5 }),
    });

    await delivered(pipeline.execute(paid()));
    const again = await delivered(pipeline.execute(paid()));

    expect(again).toMatchObject({ backendStatus: 204, body: null, headers: {} });
  });
});

describe('retry gate: retention', () => {
  it('still serves a retry just before retention ends', async () => {
    const { pipeline, clock } = setup();
    await delivered(pipeline.execute(paid()));

    clock.advance(24 * HOUR_MS - 1);

    expect((await delivered(pipeline.execute(paid('alice/2')))).redelivered).toBe(true);
  });

  it('treats a retry after retention as a new purchase', async () => {
    const { pipeline, calls, clock } = setup();
    await delivered(pipeline.execute(paid()));

    clock.advance(24 * HOUR_MS);
    const again = await delivered(pipeline.execute(paid('alice/2')));

    expect(again).not.toHaveProperty('redelivered');
    expect(calls.settle).toBe(2);
  });

  it('keeps an unresolved key closed until retention ends, then sells again', async () => {
    let settles = 0;
    const { pipeline, calls, clock } = setup({
      provider: {
        settle: async () => {
          settles += 1;
          calls.settle += 1;
          if (settles === 1) throw new Error('facilitator lost the response');
          return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
        },
      },
    });
    await refusal(pipeline.execute(paid()));

    clock.advance(24 * HOUR_MS - 1);
    const closed = await refusal(pipeline.execute(paid('alice/2')));
    clock.advance(1);
    const again = await delivered(pipeline.execute(paid('alice/3')));

    expect(closed.details?.['reason']).toBe('payment_identifier_unresolved');
    expect(again).not.toHaveProperty('redelivered');
    expect(calls.settle).toBe(2);
  });

  it("uses the resource's own retention", async () => {
    const { pipeline, calls, clock } = setup({
      resource: { idempotency: { redelivery: { retentionHours: 2, required: false } } },
    });
    await delivered(pipeline.execute(paid()));

    clock.advance(2 * HOUR_MS);
    await delivered(pipeline.execute(paid('alice/2')));

    expect(calls.settle).toBe(2);
  });
});

describe('retry gate: how a claim ends', () => {
  const refused = async () => ({
    status: 'rejected' as const,
    provider: 'x402' as const,
    amount: '0.01',
    currency: 'USDC',
    rejectionReason: 'insufficient_funds',
  });

  it.each([
    [
      'settlement refused, upfront',
      { provider: { settle: refused } },
      'PAYMENT_SETTLEMENT_FAILED',
      undefined,
    ],
    [
      'settlement refused, authorization',
      { settleAfterBackend: true, provider: { settle: refused } },
      'PAYMENT_SETTLEMENT_FAILED',
      undefined,
    ],
    [
      'settlement not submitted',
      {
        provider: {
          settle: async () => {
            throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'not sent', {
              details: { settlementNotSubmitted: true },
            });
          },
        },
      },
      'PAYMENT_PROVIDER_UNAVAILABLE',
      undefined,
    ],
    [
      'backend failed, authorization',
      {
        settleAfterBackend: true,
        backend: async () => {
          throw new CommerceError('BACKEND_ERROR', 'merchant returned 500');
        },
      },
      'BACKEND_ERROR',
      undefined,
    ],
    [
      'settlement uncertain',
      {
        provider: {
          settle: async () => {
            throw new Error('facilitator lost the response');
          },
        },
      },
      'PAYMENT_SETTLEMENT_FAILED',
      { kind: 'unresolved', owner: PROOF_DIGEST },
    ],
    [
      'settlement uncertain after the backend',
      {
        settleAfterBackend: true,
        provider: {
          settle: async () => {
            throw new Error('facilitator lost the response');
          },
        },
      },
      'PAYMENT_SETTLEMENT_FAILED',
      { kind: 'unresolved', owner: PROOF_DIGEST },
    ],
    [
      'backend failed after an upfront settlement',
      {
        backend: async () => {
          throw new CommerceError('BACKEND_ERROR', 'merchant returned 500');
        },
      },
      'BACKEND_ERROR',
      { kind: 'unresolved', owner: PROOF_DIGEST },
    ],
  ] as const)('leaves the expected claim after: %s', async (_name, options, code, expected) => {
    const { pipeline, store } = setup(options as Setup);

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe(code);
    expect(await row(store)).toEqual(expected);
  });

  it('releases the claim when the mandate is missing', async () => {
    const { pipeline, store, calls } = setup({
      authorization: true,
      resource: { authorization: { required: ['ap2'] } },
    });

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('AUTHORIZATION_REQUIRED');
    expect(calls.settle).toBe(0);
    expect(await row(store)).toBeUndefined();
  });

  it('releases the claim when the replay reservation fails', async () => {
    const { pipeline, store } = setup();
    store.reservePaymentAttempt = async () => {
      throw new Error('disk full');
    };

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('STORAGE_ERROR');
    expect(await row(store)).toBeUndefined();
  });

  it('lets a released key buy again', async () => {
    let failing = true;
    const { pipeline, calls } = setup({
      settleAfterBackend: true,
      backend: async () => {
        if (failing) throw new CommerceError('BACKEND_ERROR', 'merchant returned 500');
        return { status: 200, headers: {}, body: { ok: true }, durationMs: 5 };
      },
    });
    await refusal(pipeline.execute(paid()));
    failing = false;

    const retried = await delivered(pipeline.execute(paid('alice/2')));

    expect(retried).not.toHaveProperty('redelivered');
    expect(calls.settle).toBe(1);
  });

  it('keeps the merchant key across a re-signed retry', async () => {
    let failing = true;
    const { pipeline, sent } = setup({
      settleAfterBackend: true,
      resource: { idempotency: { merchantKey: true, ...REDELIVERY } },
      backend: async () => {
        if (failing) throw new CommerceError('BACKEND_ERROR', 'merchant returned 500');
        return { status: 200, headers: {}, body: { ok: true }, durationMs: 5 };
      },
    });
    await refusal(pipeline.execute(paid()));
    failing = false;

    await delivered(pipeline.execute(paid('alice/2')));

    expect(sent.map((request) => request.idempotencyKey)).toEqual([
      MERCHANT_KEY_FOR_CLIENT_KEY,
      MERCHANT_KEY_FOR_CLIENT_KEY,
    ]);
  });

  it('reads no client key for the merchant key without redelivery', async () => {
    const { pipeline, sent } = setup({ resource: { idempotency: { merchantKey: true } } });

    await delivered(pipeline.execute(paid()));

    expect(sent.map((request) => request.idempotencyKey)).toEqual([MERCHANT_KEY_FOR_PROOF]);
  });

  it('falls back to the proof for the merchant key when the payer is unknown', async () => {
    const { pipeline, sent } = setup({
      resource: { idempotency: { merchantKey: true, ...REDELIVERY } },
    });

    await delivered(pipeline.execute(paid('anon/1')));

    expect(sent.map((request) => request.idempotencyKey)).toEqual([MERCHANT_KEY_FOR_ANON_PROOF]);
  });

  it('sends no merchant key when only redelivery is set', async () => {
    const { pipeline, sent } = setup();

    await delivered(pipeline.execute(paid()));

    expect(sent[0]).not.toHaveProperty('idempotencyKey');
  });
});

describe('retry gate: store writes that fail after a charge', () => {
  type Update = Parameters<SqliteReceiptStore['updateIdempotencyKey']>[1]['kind'];

  function failUpdates(store: SqliteReceiptStore, failing: readonly Update[]): Update[] {
    const attempted: Update[] = [];
    const update = store.updateIdempotencyKey.bind(store);
    store.updateIdempotencyKey = async (scope, change) => {
      attempted.push(change.kind);
      if (failing.includes(change.kind)) throw new Error('disk full');
      await update(scope, change);
    };
    return attempted;
  }

  it('delivers, and closes the key, when the receipt is not saved', async () => {
    const { pipeline, store } = setup();
    store.saveReceipt = async () => {
      throw new Error('disk full');
    };
    const attempted = failUpdates(store, []);

    const outcome = await delivered(pipeline.execute(paid()));

    expect(outcome.body).toEqual({ report: 'paid data' });
    expect(outcome.persistenceFailures).toEqual(['receipt', 'response']);
    expect(attempted).toEqual(['unresolved']);
    expect(await row(store)).toEqual({ kind: 'unresolved', owner: PROOF_DIGEST });
  });

  it('delivers, and closes the key, when the completed write fails', async () => {
    const { pipeline, store, calls } = setup();
    const attempted = failUpdates(store, ['completed']);

    const outcome = await delivered(pipeline.execute(paid()));
    const retry = await refusal(pipeline.execute(paid('alice/2')));

    expect(outcome.persistenceFailures).toEqual(['response']);
    expect(attempted).toEqual(['completed', 'unresolved']);
    expect(retry.details).toEqual({ reason: 'payment_identifier_unresolved' });
    expect(calls.settle).toBe(1);
  });

  it('delivers, and keeps the key closed, when both writes fail', async () => {
    const { pipeline, store, calls } = setup();
    failUpdates(store, ['completed', 'unresolved']);

    const outcome = await delivered(pipeline.execute(paid()));
    const retry = await refusal(pipeline.execute(paid('alice/2')));

    expect(outcome.persistenceFailures).toEqual(['response']);
    expect(retry.details?.['reason']).toBe('payment_identifier_in_flight');
    expect(calls.settle).toBe(1);
  });

  it('reports the failed write on the delivered event', async () => {
    const { pipeline, store, events } = setup();
    failUpdates(store, ['completed']);

    await delivered(pipeline.execute(paid()));

    const event = events.find((candidate) => candidate.type === 'resource.delivered');
    expect(event?.data).toEqual({ persistenceFailures: ['response'] });
  });

  it('keeps the original error when the release fails', async () => {
    const { pipeline, store } = setup({
      settleAfterBackend: true,
      backend: async () => {
        throw new CommerceError('BACKEND_ERROR', 'merchant returned 500');
      },
    });
    failUpdates(store, ['released']);

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('BACKEND_ERROR');
    expect(await row(store)).toEqual({ kind: 'in-flight', owner: PROOF_DIGEST });
    const { transactions } = await store.listTransactions({});
    expect(transactions[0]?.persistenceFailures).toEqual(['response']);
  });

  it('keeps the original error when a release inside admission fails', async () => {
    const { pipeline, store } = setup();
    store.reservePaymentAttempt = async () => {
      throw new Error('disk full');
    };
    failUpdates(store, ['released']);

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('STORAGE_ERROR');
    expect(await row(store)).toEqual({ kind: 'in-flight', owner: PROOF_DIGEST });
  });

  it('keeps the original error when the unresolved write fails', async () => {
    const { pipeline, store } = setup({
      provider: {
        settle: async () => {
          throw new Error('facilitator lost the response');
        },
      },
    });
    failUpdates(store, ['unresolved']);

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('PAYMENT_SETTLEMENT_FAILED');
    expect(await row(store)).toEqual({ kind: 'in-flight', owner: PROOF_DIGEST });
    const { transactions } = await store.listTransactions({});
    expect(transactions[0]?.persistenceFailures).toEqual(['response']);
  });
});

describe('retry gate: a stored row it cannot serve', () => {
  const STORED = { proofDigest: PROOF_DIGEST, payer: 'alice', body: 1, receiptId: 'receipt-1' };
  const RECEIPT = {
    id: 'receipt-1',
    requestId: 'req-0',
    resourceId: 'res-1',
    deliveredAt: '2026-01-01T00:00:00.000Z',
    backendStatus: 200,
  };
  const PAYMENT = {
    status: 'settled',
    provider: 'x402',
    amount: '0.01',
    currency: 'USDC',
  } as const;

  async function plantRow(store: SqliteReceiptStore, body: unknown): Promise<void> {
    await store.claimIdempotencyKey(SCOPE, EMPTY_INPUT_DIGEST, '2026-06-01T00:00:00.000Z');
    await store.updateIdempotencyKey(SCOPE, { kind: 'completed', status: 200, body });
  }

  it.each([
    ['null', null],
    ['a string', 'report'],
    ['an empty object', {}],
    ['no proof digest', { ...STORED, proofDigest: undefined }],
    ['a proof digest that is not text', { ...STORED, proofDigest: 7 }],
    ['no receipt id', { ...STORED, receiptId: undefined }],
    ['a receipt id that is not text', { ...STORED, receiptId: 7 }],
    ['no body', { ...STORED, body: undefined }],
    ['a payer that is not text', { ...STORED, payer: 7 }],
    ['an authorization digest that is not text', { ...STORED, authorizationDigest: 7 }],
    ['a content type that is not text', { ...STORED, contentType: 7 }],
  ])('answers unresolved for a row with %s, settling nothing', async (_name, body) => {
    const { pipeline, store, calls } = setup();
    await plantRow(store, body);
    // With the receipt present, only the row's own fields can refuse
    await store.saveReceipt({ ...RECEIPT, payment: PAYMENT });

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('PAYMENT_REPLAYED');
    expect(error.details).toEqual({ reason: 'payment_identifier_unresolved' });
    // Verify first when the stored row cannot identify its owning proof
    expect(calls).toMatchObject({ createRequirement: 1, verify: 1, settle: 0 });
  });

  it.each([
    ['an exact resend', 'alice/1'],
    ['a fresh proof', 'alice/2'],
  ])('answers unresolved for %s when the receipt is gone', async (_name, payload) => {
    const { pipeline, store, calls } = setup();
    await plantRow(store, STORED);

    const error = await refusal(pipeline.execute(paid(payload)));

    expect(error.details).toEqual({ reason: 'payment_identifier_unresolved' });
    expect(calls.settle).toBe(0);
  });

  it('answers unresolved for a receipt with no payment', async () => {
    const { pipeline, store, calls } = setup();
    await plantRow(store, STORED);
    await store.saveReceipt(RECEIPT);

    const error = await refusal(pipeline.execute(paid()));

    expect(error.details).toEqual({ reason: 'payment_identifier_unresolved' });
    expect(calls.settle).toBe(0);
  });

  it('serves a receipt that has no transaction id, naming no original', async () => {
    const { pipeline, store, events } = setup();
    await plantRow(store, STORED);
    await store.saveReceipt({ ...RECEIPT, payment: PAYMENT });

    const again = await delivered(pipeline.execute(paid()));

    expect(again.transactionId).toBe(events.at(-1)?.transactionId);
    expect(events.at(-1)?.data).toEqual({ redelivered: true });
  });

  it('answers STORAGE_ERROR for a corrupt row, calling no provider', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'retry-gate-')), 'receipts.sqlite');
    const { pipeline, store, calls } = setup({ path });
    await plantRow(store, STORED);
    const db = new Database(path);
    db.prepare('UPDATE idempotency_keys SET body_json = ?').run('{not json');
    db.close();

    const error = await refusal(pipeline.execute(paid()));

    expect(error).toMatchObject({ code: 'STORAGE_ERROR', requestId: expect.any(String) });
    expect(calls).toMatchObject({ createRequirement: 0, verify: 0, settle: 0 });
  });

  it('answers STORAGE_ERROR when the claim read fails, calling no provider', async () => {
    const { pipeline, store, calls } = setup();
    store.getIdempotencyKey = async () => {
      throw new Error('disk gone');
    };

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('STORAGE_ERROR');
    expect(calls.createRequirement).toBe(0);
  });

  it('answers STORAGE_ERROR when the claim write fails, settling nothing', async () => {
    const { pipeline, store, calls } = setup();
    store.claimIdempotencyKey = async () => {
      throw new Error('disk gone');
    };

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('STORAGE_ERROR');
    expect(calls.settle).toBe(0);
  });

  it('answers STORAGE_ERROR when the receipt read fails, settling nothing', async () => {
    const { pipeline, store, calls } = setup();
    await delivered(pipeline.execute(paid()));
    store.getReceipt = async () => {
      throw new Error('disk gone');
    };

    const error = await refusal(pipeline.execute(paid()));

    expect(error.code).toBe('STORAGE_ERROR');
    expect(calls.settle).toBe(1);
  });
});

describe('retry gate: a pipeline that cannot serve the resource', () => {
  function pipelineWith(
    resource: Partial<CommerceResource>,
    store: Parameters<typeof createExecutionPipeline>[0]['store'],
    deployment: string | undefined,
  ) {
    const providerCalls: string[] = [];
    const base = createFakePaymentProvider();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([makeResource({ ...OPTED_IN, ...resource })]),
      paymentProviders: [
        {
          ...base,
          createRequirement: (ctx) => {
            providerCalls.push('createRequirement');
            return base.createRequirement(ctx);
          },
        },
      ],
      store,
      backend: createFakeBackendExecutor(),
      events: { emit: async () => {} },
      logger: recordingLogger(),
      clock: movableClock(),
      ids: createFakeIdGenerator(),
      ...(deployment !== undefined ? { deployment } : {}),
    });
    return { pipeline, providerCalls };
  }

  function sqliteWithout(method?: keyof SqliteReceiptStore): SqliteReceiptStore {
    const store = createSqliteReceiptStore({ path: ':memory:', clock: movableClock() });
    stores.push(store);
    if (method !== undefined) Reflect.deleteProperty(store, method);
    return store;
  }

  const WITHOUT_PROOF = paid('x', { payment: undefined as never });

  it.each([
    ['a store with no claims', () => createFakeStore(), DEPLOYMENT],
    ['a store with no claim read', () => sqliteWithout('getIdempotencyKey'), DEPLOYMENT],
    ['a store with no claim write', () => sqliteWithout('claimIdempotencyKey'), DEPLOYMENT],
    ['no deployment', () => sqliteWithout(), undefined],
  ])('refuses before any provider call with %s', async (_name, store, deployment) => {
    const { pipeline, providerCalls } = pipelineWith({}, store(), deployment);

    for (const request of [paid(), WITHOUT_PROOF]) {
      const error = await refusal(pipeline.execute(request));

      expect(error).toMatchObject({ code: 'CONFIG_INVALID', requestId: request.requestId });
    }
    expect(providerCalls).toEqual([]);
  });

  it.each([[0], [1.5], [8761], [3_000_000_000], [Number.POSITIVE_INFINITY]])(
    'refuses a retention of %s hours before any provider call',
    async (retentionHours) => {
      const resource = { idempotency: { redelivery: { retentionHours, required: false } } };
      const { pipeline, providerCalls } = pipelineWith(resource, sqliteWithout(), DEPLOYMENT);

      const error = await refusal(pipeline.execute(paid()));

      expect(error).toMatchObject({ code: 'CONFIG_INVALID', resourceId: 'res-1' });
      expect(providerCalls).toEqual([]);
    },
  );

  it('accepts a retention of one year', () => {
    const resource = makeResource({
      ...OPTED_IN,
      idempotency: { redelivery: { retentionHours: 8760, required: false } },
    });

    expect(assertRetrySupport(resource, sqliteWithout(), DEPLOYMENT)).toBeDefined();
  });

  it('names no request when a caller outside a request checks support', () => {
    const resource = makeResource(OPTED_IN);

    const check = () => assertRetrySupport(resource, createFakeStore(), DEPLOYMENT);

    expect(check).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', resourceId: 'res-1' }));
    expect(() => check()).toThrow(expect.not.objectContaining({ requestId: expect.anything() }));
  });

  it('asks nothing of a resource with merchantKey off', async () => {
    const { pipeline } = pipelineWith(
      { idempotency: { merchantKey: false } },
      createFakeStore(),
      undefined,
    );

    await delivered(pipeline.execute(paid()));
  });

  it('asks a store only for what a merchant key needs', async () => {
    const { pipeline } = pipelineWith(
      { idempotency: { merchantKey: true } },
      createFakeStore(),
      DEPLOYMENT,
    );

    await delivered(pipeline.execute(paid()));
  });
});
