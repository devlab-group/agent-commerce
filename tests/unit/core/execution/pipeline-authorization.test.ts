/**
 * Authorization is a gate on settlement, so these tests assert call counts and
 * ordering rather than return values: "the resource was refused" is worth
 * little if the payment settled on the way to refusing it.
 */
import { describe, expect, it } from 'vitest';
import type { AuthorizationMethodName } from '../../../../src/core/domain/common.js';
import type { CommerceEvent } from '../../../../src/core/domain/event.js';
import type {
  CanonicalRequest,
  DeliveredOutcome,
  PaymentRequiredOutcome,
} from '../../../../src/core/domain/request.js';
import { CommerceError, isCommerceError } from '../../../../src/core/errors/index.js';
import {
  type CreateExecutionPipelineOptions,
  createExecutionPipeline,
} from '../../../../src/core/execution/pipeline.js';
import { createResourceRegistry } from '../../../../src/core/execution/registry.js';
import {
  createCapturingLogger,
  createFakeAuthorizationProvider,
  createFakeBackendExecutor,
  createFakeClock,
  createFakeIdGenerator,
  createFakePaymentProvider,
  createFakeStore,
  type FakeStore,
  makeResource,
} from './helpers.js';

const PAID = {
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  paymentMethods: ['x402'],
  authorization: { required: ['ap2'] },
} as const;

// Omits a key outright: `exactOptionalPropertyTypes` refuses an explicit undefined
function without(
  request: CanonicalRequest,
  ...keys: readonly ('payment' | 'authorization')[]
): CanonicalRequest {
  const copy = { ...request };
  for (const key of keys) delete copy[key];
  return copy;
}

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: 'req-1',
    resourceId: 'res-1',
    input: { city: 'berlin' },
    protocol: 'http',
    receivedAt: '2026-01-01T00:00:00.000Z',
    payment: { method: 'x402', payload: 'proof' },
    authorization: { method: 'ap2', payload: 'mandate~disclosure~' },
    ...overrides,
  };
}

function buildPipeline(overrides: Partial<CreateExecutionPipelineOptions> & { store?: FakeStore }) {
  const store = overrides.store ?? createFakeStore();
  return {
    store,
    pipeline: createExecutionPipeline({
      resources: createResourceRegistry([makeResource({ ...PAID })]),
      paymentProviders: [createFakePaymentProvider()],
      backend: createFakeBackendExecutor(),
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
      ...overrides,
      store,
      events: store,
    }),
  };
}

function codeOf(error: unknown): string {
  return isCommerceError(error) ? error.code : `not-a-commerce-error:${String(error)}`;
}

function types(store: FakeStore): string[] {
  return store.events.map((e: CommerceEvent) => e.type);
}

describe('execution pipeline authorization', () => {
  it('advertises the authorization requirement with the payment challenge', async () => {
    const auth = createFakeAuthorizationProvider({
      requirement: { method: 'ap2', version: '0.2.0', profile: 'agent-commerce/ap2/checkout/v1' },
    });
    const { pipeline } = buildPipeline({ authorizationProviders: [auth] });

    const outcome = (await pipeline.execute(
      without(makeRequest(), 'payment', 'authorization'),
    )) as PaymentRequiredOutcome;

    expect(outcome.kind).toBe('payment-required');
    expect(outcome.authorization).toEqual([
      { method: 'ap2', version: '0.2.0', profile: 'agent-commerce/ap2/checkout/v1' },
    ]);
    expect(auth.calls).toEqual([]);
  });

  it('leaves the challenge untouched for a paid resource that requires no authorization', async () => {
    const auth = createFakeAuthorizationProvider();
    const { pipeline } = buildPipeline({
      resources: createResourceRegistry([
        makeResource({ pricing: PAID.pricing, paymentMethods: ['x402'] }),
      ]),
      authorizationProviders: [auth],
    });

    const outcome = (await pipeline.execute(
      without(makeRequest(), 'payment', 'authorization'),
    )) as PaymentRequiredOutcome;

    expect(outcome.authorization).toBeUndefined();
  });

  it('settles, consumes and delivers in that order on the happy path', async () => {
    const order: string[] = [];
    const auth = createFakeAuthorizationProvider({
      onCall: (action) => order.push(`auth.${action}`),
    });
    const store = createFakeStore({
      reservePaymentAttempt: async (reservation) => {
        order.push('store.reservePaymentAttempt');
        return {
          id: 'attempt-1',
          requestId: reservation.requestId,
          resourceId: reservation.resourceId,
          provider: reservation.provider,
          replayKey: reservation.replayKey,
          status: 'reserved',
          amount: reservation.amount,
          currency: reservation.currency,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      },
    });
    const payment = createFakePaymentProvider({
      verify: async () => {
        order.push('payment.verify');
        return {
          status: 'verified',
          provider: 'x402',
          amount: '0.01',
          currency: 'USDC',
          replayKey: 'replay-key-1',
        };
      },
      settle: async () => {
        order.push('payment.settle');
        return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
      },
    });
    const { pipeline } = buildPipeline({
      store,
      paymentProviders: [payment],
      authorizationProviders: [auth],
      backend: createFakeBackendExecutor(async () => {
        order.push('backend.call');
        return { status: 200, headers: {}, body: { ok: true }, durationMs: 1 };
      }),
    });

    const outcome = (await pipeline.execute(makeRequest())) as DeliveredOutcome;

    expect(outcome.kind).toBe('delivered');
    expect(order).toEqual([
      'payment.verify',
      'auth.verifyAndReserve',
      'store.reservePaymentAttempt',
      'payment.settle',
      'auth.consume',
      'backend.call',
    ]);
  });

  it('binds the proof to the validated input and the resolved price', async () => {
    const auth = createFakeAuthorizationProvider();
    const { pipeline } = buildPipeline({ authorizationProviders: [auth] });

    await pipeline.execute(makeRequest({ input: { city: 'berlin', _payment: 'proof' } }));

    const context = auth.contexts[0];
    expect(context?.resourceId).toBe('res-1');
    // Reserved wire fields stripped: the provider hashes this, and the backend
    // is called with the same bytes
    expect(context?.input).toEqual({ city: 'berlin' });
    expect(context?.requirement.amount).toBe('0.01');
    expect(context?.requirement.currency).toBe('USDC');
    expect(context?.submission).toEqual({ method: 'ap2', payload: 'mandate~disclosure~' });
  });

  it('records a digest on the receipt and never the reservation handle', async () => {
    const auth = createFakeAuthorizationProvider();
    const { pipeline, store } = buildPipeline({ authorizationProviders: [auth] });

    const outcome = (await pipeline.execute(makeRequest())) as DeliveredOutcome;

    expect(outcome.receipt.authorization).toEqual({
      method: 'ap2',
      reference: 'sha256:REFERENCE',
      metadata: { checkoutId: 'checkout-1' },
    });
    expect(JSON.stringify(store.receipts[0])).not.toContain('reservation-1');
    expect(JSON.stringify(store.receipts[0])).not.toContain('mandate~disclosure~');
  });

  it('emits authorization.verified between payment verification and settlement', async () => {
    const auth = createFakeAuthorizationProvider();
    const { pipeline, store } = buildPipeline({ authorizationProviders: [auth] });

    await pipeline.execute(makeRequest());

    expect(types(store)).toEqual([
      'resource.requested',
      'authorization.verified',
      'payment.verified',
      'payment.settled',
      'backend.called',
      'resource.delivered',
    ]);
    const verified = store.events.find((e) => e.type === 'authorization.verified');
    expect(verified?.data).toEqual({ method: 'ap2', reference: 'sha256:REFERENCE' });
  });

  describe('refusals before any money moves', () => {
    it('refuses a request with no authorization at all', async () => {
      const auth = createFakeAuthorizationProvider();
      let settled = 0;
      let backendCalls = 0;
      const { pipeline, store } = buildPipeline({
        authorizationProviders: [auth],
        paymentProviders: [
          createFakePaymentProvider({
            settle: async () => {
              settled += 1;
              return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
            },
          }),
        ],
        backend: createFakeBackendExecutor(async () => {
          backendCalls += 1;
          return { status: 200, headers: {}, body: {}, durationMs: 1 };
        }),
      });

      await expect(pipeline.execute(without(makeRequest(), 'authorization'))).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'AUTHORIZATION_REQUIRED',
      );
      expect(settled).toBe(0);
      expect(backendCalls).toBe(0);
      expect(auth.calls).toEqual([]);
      expect(store.attempts.size).toBe(0);
      expect(types(store)).toContain('authorization.rejected');
    });

    it('refuses a proof presented under a method the resource does not require', async () => {
      const auth = createFakeAuthorizationProvider();
      const { pipeline } = buildPipeline({ authorizationProviders: [auth] });

      await expect(
        pipeline.execute(
          makeRequest({
            authorization: { method: 'other' as 'ap2', payload: 'x' },
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'AUTHORIZATION_REQUIRED');
      expect(auth.calls).toEqual([]);
    });

    it('refuses a resource requiring two methods, since one request carries one proof', async () => {
      // The union has one member today; the cast stands in for a second method
      // and pins that it is refused rather than quietly skipped
      const second = 'mock' as AuthorizationMethodName;
      const ap2 = createFakeAuthorizationProvider();
      const other = createFakeAuthorizationProvider({ name: second });
      const { pipeline } = buildPipeline({
        resources: createResourceRegistry([
          makeResource({
            pricing: PAID.pricing,
            paymentMethods: ['x402'],
            authorization: { required: ['ap2', second] },
          }),
        ]),
        authorizationProviders: [ap2, other],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'AUTHORIZATION_REQUIRED',
      );
      expect(ap2.calls).toEqual([]);
      expect(other.calls).toEqual([]);
    });

    it('names the unsatisfied methods, not the satisfied one', async () => {
      const second = 'mock' as AuthorizationMethodName;
      const { pipeline } = buildPipeline({
        resources: createResourceRegistry([
          makeResource({
            pricing: PAID.pricing,
            paymentMethods: ['x402'],
            authorization: { required: ['ap2', second] },
          }),
        ]),
        authorizationProviders: [
          createFakeAuthorizationProvider(),
          createFakeAuthorizationProvider({ name: second }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) =>
          isCommerceError(error) &&
          JSON.stringify(error.details?.['missing']) === JSON.stringify(['mock']),
      );
    });

    it('propagates an invalid proof as AUTHORIZATION_INVALID, with no settlement', async () => {
      let settled = 0;
      const auth = createFakeAuthorizationProvider({
        verifyAndReserve: async () => {
          throw new CommerceError('AUTHORIZATION_INVALID', 'mandate rejected');
        },
      });
      const { pipeline, store } = buildPipeline({
        authorizationProviders: [auth],
        paymentProviders: [
          createFakePaymentProvider({
            settle: async () => {
              settled += 1;
              return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
            },
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'AUTHORIZATION_INVALID',
      );
      expect(settled).toBe(0);
      expect(store.attempts.size).toBe(0);
      expect(auth.calls).toEqual(['verifyAndReserve']);
      const rejected = store.events.find((e) => e.type === 'authorization.rejected');
      expect(rejected?.data).toEqual({ reason: 'AUTHORIZATION_INVALID', method: 'ap2' });
    });

    it('propagates a replayed proof as AUTHORIZATION_REPLAYED', async () => {
      const auth = createFakeAuthorizationProvider({
        verifyAndReserve: async () => {
          throw new CommerceError('AUTHORIZATION_REPLAYED', 'already spent');
        },
      });
      const { pipeline } = buildPipeline({ authorizationProviders: [auth] });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'AUTHORIZATION_REPLAYED',
      );
    });

    it('reports an untyped provider failure as unavailable, not as a bad proof', async () => {
      const auth = createFakeAuthorizationProvider({
        verifyAndReserve: async () => {
          throw new Error('sqlite: database is locked');
        },
      });
      const { pipeline } = buildPipeline({ authorizationProviders: [auth] });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'AUTHORIZATION_PROVIDER_UNAVAILABLE',
      );
    });

    it('never reserves a proof for a payment that failed verification', async () => {
      const auth = createFakeAuthorizationProvider();
      const { pipeline } = buildPipeline({
        authorizationProviders: [auth],
        paymentProviders: [
          createFakePaymentProvider({
            verify: async () => ({
              status: 'rejected',
              provider: 'x402',
              amount: '0.01',
              currency: 'USDC',
              rejectionReason: 'wrong amount',
            }),
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'PAYMENT_INVALID',
      );
      expect(auth.calls).toEqual([]);
    });

    it('refuses a resource requiring a method no provider implements', async () => {
      let createRequirementCalls = 0;
      const { pipeline } = buildPipeline({
        authorizationProviders: [],
        paymentProviders: [
          createFakePaymentProvider({
            createRequirement: async (ctx) => {
              createRequirementCalls += 1;
              return {
                id: 'r',
                requestId: ctx.requestId,
                resourceId: ctx.resource.id,
                provider: 'x402',
                amount: ctx.amount,
                currency: ctx.currency,
                destination: '0xM',
                challenge: { provider: 'x402', version: '1', accepts: [] },
              };
            },
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'CONFIG_INVALID',
      );
      expect(createRequirementCalls).toBe(0);
    });

    it('refuses a free resource that requires authorization rather than serving it unchecked', async () => {
      const auth = createFakeAuthorizationProvider();
      let backendCalls = 0;
      const { pipeline } = buildPipeline({
        resources: createResourceRegistry([
          makeResource({ pricing: { type: 'free' }, authorization: { required: ['ap2'] } }),
        ]),
        authorizationProviders: [auth],
        backend: createFakeBackendExecutor(async () => {
          backendCalls += 1;
          return { status: 200, headers: {}, body: {}, durationMs: 1 };
        }),
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'CONFIG_INVALID',
      );
      expect(backendCalls).toBe(0);
      expect(auth.calls).toEqual([]);
    });
  });

  describe('finalization', () => {
    it('releases the reservation when the payment replay key is already spent', async () => {
      let settled = 0;
      const auth = createFakeAuthorizationProvider();
      const { pipeline } = buildPipeline({
        authorizationProviders: [auth],
        store: createFakeStore({
          reservePaymentAttempt: async () => {
            throw new CommerceError('PAYMENT_REPLAYED', 'already reserved');
          },
        }),
        paymentProviders: [
          createFakePaymentProvider({
            settle: async () => {
              settled += 1;
              return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
            },
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'PAYMENT_REPLAYED',
      );
      expect(auth.calls).toEqual(['verifyAndReserve', 'release']);
      expect(settled).toBe(0);
    });

    it('releases the reservation when settlement is definitively rejected', async () => {
      const auth = createFakeAuthorizationProvider();
      const { pipeline } = buildPipeline({
        authorizationProviders: [auth],
        paymentProviders: [
          createFakePaymentProvider({
            settle: async () => ({
              status: 'rejected',
              provider: 'x402',
              amount: '0.01',
              currency: 'USDC',
              rejectionReason: 'insufficient balance',
            }),
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'PAYMENT_SETTLEMENT_FAILED',
      );
      expect(auth.calls).toEqual(['verifyAndReserve', 'release']);
    });

    it('releases the reservation when settlement throws without moving funds', async () => {
      const auth = createFakeAuthorizationProvider();
      const { pipeline } = buildPipeline({
        authorizationProviders: [auth],
        paymentProviders: [
          createFakePaymentProvider({
            settle: async () => {
              throw new Error('facilitator refused the request');
            },
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'PAYMENT_SETTLEMENT_FAILED',
      );
      expect(auth.calls).toEqual(['verifyAndReserve', 'release']);
    });

    it('marks the reservation uncertain when a broadcast settlement was never confirmed', async () => {
      const auth = createFakeAuthorizationProvider();
      const { pipeline } = buildPipeline({
        authorizationProviders: [auth],
        paymentProviders: [
          createFakePaymentProvider({
            settle: async () => {
              throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'confirmation timed out', {
                details: { transactionHash: '0xabc' },
              });
            },
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'PAYMENT_SETTLEMENT_FAILED',
      );
      // Not released: the buyer's funds may already have moved, and a released
      // mandate is spendable again
      expect(auth.calls).toEqual(['verifyAndReserve', 'markUncertain']);
    });

    it('keeps the reservation consumed when the backend fails after settlement', async () => {
      const auth = createFakeAuthorizationProvider();
      const { pipeline, store } = buildPipeline({
        authorizationProviders: [auth],
        backend: createFakeBackendExecutor(async () => {
          throw new CommerceError('BACKEND_ERROR', 'merchant returned 500', {
            details: { status: 500 },
          });
        }),
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'BACKEND_ERROR',
      );
      expect(auth.calls).toEqual(['verifyAndReserve', 'consume']);
      expect(store.receipts[0]?.authorization?.reference).toBe('sha256:REFERENCE');
    });

    it('delivers even when consuming the reservation fails', async () => {
      const logger = createCapturingLogger();
      const auth = createFakeAuthorizationProvider({
        consume: async () => {
          throw new Error('sqlite: disk I/O error');
        },
      });
      const { pipeline } = buildPipeline({ authorizationProviders: [auth], logger });

      const outcome = (await pipeline.execute(makeRequest())) as DeliveredOutcome;

      expect(outcome.kind).toBe('delivered');
      expect(logger.errors.some((e) => e.obj['action'] === 'consume')).toBe(true);
    });

    it('does not mask the original failure when releasing the reservation fails', async () => {
      const auth = createFakeAuthorizationProvider({
        release: async () => {
          throw new Error('sqlite: disk I/O error');
        },
      });
      const { pipeline } = buildPipeline({
        authorizationProviders: [auth],
        paymentProviders: [
          createFakePaymentProvider({
            settle: async () => ({
              status: 'rejected',
              provider: 'x402',
              amount: '0.01',
              currency: 'USDC',
            }),
          }),
        ],
      });

      await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === 'PAYMENT_SETTLEMENT_FAILED',
      );
    });
  });

  it('leaves a paid resource without authorization exactly as it was', async () => {
    const auth = createFakeAuthorizationProvider();
    const { pipeline, store } = buildPipeline({
      resources: createResourceRegistry([
        makeResource({ pricing: PAID.pricing, paymentMethods: ['x402'] }),
      ]),
      authorizationProviders: [auth],
    });

    const outcome = (await pipeline.execute(
      without(makeRequest(), 'authorization'),
    )) as DeliveredOutcome;

    expect(outcome.kind).toBe('delivered');
    expect(auth.calls).toEqual([]);
    expect(outcome.receipt.authorization).toBeUndefined();
    expect(types(store)).not.toContain('authorization.verified');
  });
});
