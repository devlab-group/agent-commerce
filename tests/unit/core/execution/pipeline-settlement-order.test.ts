/**
 * A provider can defer settlement until the backend succeeds, as the x402
 * `authorization` flow does. The response is held until settlement succeeds.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalRequest } from '../../../../src/core/domain/request';
import { CommerceError, isCommerceError } from '../../../../src/core/errors';
import { createExecutionPipeline } from '../../../../src/core/execution/pipeline';
import { createResourceRegistry } from '../../../../src/core/execution/registry';
import {
  createCapturingLogger,
  createFakeAuthorizationProvider,
  createFakeBackendExecutor,
  createFakeClock,
  createFakeIdGenerator,
  createFakePaymentProvider,
  createFakeStore,
  type FakePaymentProviderOptions,
  makeResource,
} from './helpers';

const PAID = {
  id: 'res-1',
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  paymentMethods: ['x402'],
} as const;

function paidRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: 'req-1',
    resourceId: 'res-1',
    input: {},
    protocol: 'http',
    receivedAt: '2026-01-01T00:00:00.000Z',
    payment: { method: 'x402', payload: 'proof' },
    ...overrides,
  };
}

function setup(options: {
  readonly provider?: FakePaymentProviderOptions;
  readonly backendFails?: boolean;
  readonly withAuthorization?: boolean;
}) {
  const order: string[] = [];
  const store = createFakeStore();
  const auth = createFakeAuthorizationProvider();
  const pipeline = createExecutionPipeline({
    resources: createResourceRegistry([
      makeResource({
        ...PAID,
        ...(options.withAuthorization ? { authorization: { required: ['ap2'] } } : {}),
      }),
    ]),
    paymentProviders: [
      createFakePaymentProvider({
        requirementMetadata: { settleAfterBackend: true },
        settle: async () => {
          order.push('settle');
          return {
            status: 'settled',
            provider: 'x402',
            amount: '0.01',
            currency: 'USDC',
            externalReference: 'tx-1',
          };
        },
        ...options.provider,
      }),
    ],
    ...(options.withAuthorization ? { authorizationProviders: [auth] } : {}),
    store,
    backend: createFakeBackendExecutor(async () => {
      order.push('backend');
      if (options.backendFails) {
        throw new CommerceError('BACKEND_ERROR', 'merchant returned 500', {
          details: { status: 500 },
        });
      }
      return { status: 200, headers: {}, body: { report: 'ok' }, durationMs: 1 };
    }),
    events: store,
    logger: createCapturingLogger(),
    clock: createFakeClock(),
    ids: createFakeIdGenerator(),
  });
  return { pipeline, store, order, auth };
}

async function refusal(run: Promise<unknown>): Promise<CommerceError> {
  try {
    await run;
  } catch (error) {
    if (isCommerceError(error)) return error;
    throw error;
  }
  return expect.unreachable('expected the pipeline to refuse') as never;
}

describe('settling after the backend', () => {
  it('calls the backend first and delivers what settled', async () => {
    const { pipeline, store, order } = setup({});

    const outcome = await pipeline.execute(paidRequest());

    expect(order).toEqual(['backend', 'settle']);
    expect(outcome).toMatchObject({ kind: 'delivered', payment: { externalReference: 'tx-1' } });
    expect([...store.attempts.values()][0]?.status).toBe('settled');
    expect(store.receipts).toHaveLength(1);
  });

  it('does not settle after a backend failure', async () => {
    const { pipeline, store, order } = setup({ backendFails: true });

    const error = await refusal(pipeline.execute(paidRequest()));

    expect(order).toEqual(['backend']);
    expect(error.code).toBe('BACKEND_ERROR');
    expect(error.details).not.toHaveProperty('payment');
    expect([...store.attempts.values()][0]).toMatchObject({
      status: 'rejected',
      rejectionReason: 'backend_failed',
    });
    expect(store.receipts).toHaveLength(0);
    expect(store.events.map((e) => e.type)).toContain('payment.rejected');
  });

  it('answers a retry with the same authorization with a fresh challenge', async () => {
    const { pipeline } = setup({ backendFails: true });
    await refusal(pipeline.execute(paidRequest()));

    const replay = await refusal(pipeline.execute(paidRequest({ requestId: 'req-2' })));

    expect(replay.code).toBe('PAYMENT_REPLAYED');
    expect(replay.httpStatus).toBe(402);
  });

  it('withholds the response when settlement is refused after the backend', async () => {
    const { pipeline, store, order } = setup({
      provider: {
        settle: async () => ({
          status: 'rejected',
          provider: 'x402',
          amount: '0.01',
          currency: 'USDC',
          rejectionReason: 'insufficient_funds',
        }),
      },
    });

    const error = await refusal(pipeline.execute(paidRequest()));

    expect(order).toEqual(['backend']);
    expect(error).toMatchObject({ code: 'PAYMENT_SETTLEMENT_FAILED', httpStatus: 402 });
    expect(store.receipts).toHaveLength(0);
  });

  it('withholds the response when settlement cannot be confirmed', async () => {
    const { pipeline, store } = setup({
      provider: {
        settle: async () => {
          throw new Error('facilitator lost the response');
        },
      },
    });

    const error = await refusal(pipeline.execute(paidRequest()));

    expect(error.code).toBe('PAYMENT_SETTLEMENT_FAILED');
    expect(error.details?.['settlementUncertain']).toBe(true);
    expect([...store.attempts.values()][0]?.status).toBe('settlement-uncertain');
    expect(store.receipts).toHaveLength(0);
  });

  it('releases the authorization reservation when the backend fails', async () => {
    const { pipeline, auth } = setup({ backendFails: true, withAuthorization: true });

    await refusal(
      pipeline.execute(paidRequest({ authorization: { method: 'ap2', payload: 'mandate~' } })),
    );

    expect(auth.calls).toEqual(['verifyAndReserve', 'release']);
  });

  it('consumes the authorization reservation once the payment settles', async () => {
    const { pipeline, auth } = setup({ withAuthorization: true });

    await pipeline.execute(paidRequest({ authorization: { method: 'ap2', payload: 'mandate~' } }));

    expect(auth.calls).toEqual(['verifyAndReserve', 'consume']);
  });

  it('keeps settling first for a provider that does not ask', async () => {
    const { pipeline, order } = setup({ provider: { requirementMetadata: {} } });

    await pipeline.execute(paidRequest());

    expect(order).toEqual(['settle', 'backend']);
  });
});
