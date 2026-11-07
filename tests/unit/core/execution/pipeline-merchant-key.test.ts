/**
 * Check when `idempotency.merchantKey` adds a key to backend requests.
 * Key derivation is tested in merchant-key.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalRequest } from '../../../../src/core/domain/request';
import type { CommerceResource } from '../../../../src/core/domain/resource';
import { isCommerceError } from '../../../../src/core/errors';
import { createExecutionPipeline } from '../../../../src/core/execution/pipeline';
import { createResourceRegistry } from '../../../../src/core/execution/registry';
import type { BackendRequest } from '../../../../src/core/interfaces/backend';
import {
  createCapturingLogger,
  createFakeBackendExecutor,
  createFakeClock,
  createFakeIdGenerator,
  createFakePaymentProvider,
  createFakeStore,
  makeResource,
} from './helpers';

// sha256sum of ["paid-operation","https://gw.example","res-1","replay-key-1","sha256:<digest of {}>"]
const KEY = '00109a2fb4bde23d050022a9e07ad3e8279087352c638f2f1649d847482bdf05';

const PAID = {
  id: 'res-1',
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  paymentMethods: ['x402'],
} as const;
const OPTED_IN = { ...PAID, idempotency: { merchantKey: true } };

const UNPAID_REQUEST: CanonicalRequest = {
  requestId: 'req-1',
  resourceId: 'res-1',
  input: {},
  protocol: 'http',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

function paidRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return { ...UNPAID_REQUEST, payment: { method: 'x402', payload: 'proof' }, ...overrides };
}

function setup(
  resource: Partial<CommerceResource>,
  options: { readonly deployment?: string; readonly settleAfterBackend?: boolean } = {
    deployment: 'https://gw.example',
  },
) {
  const providerCalls: string[] = [];
  const sent: BackendRequest[] = [];
  const store = createFakeStore();
  const provider = createFakePaymentProvider({
    ...(options.settleAfterBackend ? { requirementMetadata: { settleAfterBackend: true } } : {}),
  });
  const pipeline = createExecutionPipeline({
    resources: createResourceRegistry([makeResource(resource)]),
    paymentProviders: [
      {
        ...provider,
        createRequirement: (ctx) => {
          providerCalls.push('createRequirement');
          return provider.createRequirement(ctx);
        },
        verify: (ctx) => {
          providerCalls.push('verify');
          return provider.verify(ctx);
        },
      },
    ],
    store,
    backend: createFakeBackendExecutor(async (_handler, request) => {
      sent.push(request);
      return { status: 200, headers: {}, body: { ok: true }, durationMs: 1 };
    }),
    events: store,
    logger: createCapturingLogger(),
    clock: createFakeClock(),
    ids: createFakeIdGenerator(),
    ...(options.deployment !== undefined ? { deployment: options.deployment } : {}),
  });
  return { pipeline, sent, store, providerCalls };
}

describe('merchant idempotency key', () => {
  it.each([
    ['upfront', false],
    ['authorization', true],
  ])('sends the derived key under the %s flow', async (_flow, settleAfterBackend) => {
    const { pipeline, sent } = setup(OPTED_IN, {
      deployment: 'https://gw.example',
      settleAfterBackend,
    });

    const outcome = await pipeline.execute(paidRequest());

    expect(outcome.kind).toBe('delivered');
    expect(sent.map((request) => request.idempotencyKey)).toEqual([KEY]);
  });

  it("keeps the protocol's own key, which ACP sends", async () => {
    const { pipeline, sent } = setup(OPTED_IN);

    await pipeline.execute(paidRequest({ idempotencyKey: 'acp-key' }));

    expect(sent.map((request) => request.idempotencyKey)).toEqual(['acp-key']);
  });

  it.each([
    ['omitted', PAID],
    ['false', { ...PAID, idempotency: { merchantKey: false } }],
  ])('sends no key when merchantKey is %s', async (_name, resource) => {
    const { pipeline, sent } = setup(resource);

    const outcome = await pipeline.execute(paidRequest());

    expect(outcome.kind).toBe('delivered');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('idempotencyKey');
  });

  it('sends no key on a free resource and still delivers', async () => {
    const { pipeline, sent } = setup({ id: 'res-1', idempotency: { merchantKey: true } });

    const outcome = await pipeline.execute(UNPAID_REQUEST);

    expect(outcome.kind).toBe('delivered');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('idempotencyKey');
  });

  it('sends no key for input that is not I-JSON and still delivers', async () => {
    const { pipeline, sent, store } = setup(OPTED_IN);

    const outcome = await pipeline.execute(paidRequest({ input: { text: '\uD800' } }));

    expect(outcome.kind).toBe('delivered');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('idempotencyKey');
    expect(store.receipts[0]?.payment?.status).toBe('settled');
  });

  it.each([
    ['with a proof', paidRequest()],
    ['without a proof', UNPAID_REQUEST],
  ])(
    'refuses a request %s before any provider call when deployment is missing',
    async (_name, request) => {
      const { pipeline, sent, store, providerCalls } = setup(OPTED_IN, {});

      const error = await pipeline.execute(request).catch((err: unknown) => err);

      expect(isCommerceError(error) && error.code).toBe('CONFIG_INVALID');
      expect(providerCalls).toEqual([]);
      expect(sent).toEqual([]);
      expect(store.attempts.size).toBe(0);
    },
  );
});
