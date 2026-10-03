import { describe, expect, it } from 'vitest';
import type { CommerceEvent, CommerceEventType } from '../../../../src/core/domain/event';
import type {
  CanonicalRequest,
  DeliveredOutcome,
  PaymentRequiredOutcome,
} from '../../../../src/core/domain/request';
import { isCommerceError } from '../../../../src/core/errors';
import { createExecutionPipeline } from '../../../../src/core/execution/pipeline';
import { createResourceRegistry } from '../../../../src/core/execution/registry';
import {
  createCapturingLogger,
  createFakeBackendExecutor,
  createFakeClock,
  createFakeIdGenerator,
  createFakePaymentProvider,
  createFakeStore,
  makeResource,
} from './helpers';

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    requestId: 'req-1',
    resourceId: 'res-1',
    input: {},
    protocol: 'http',
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function eventTypes(store: ReturnType<typeof createFakeStore>): CommerceEventType[] {
  return store.events.map((e: CommerceEvent) => e.type);
}

// Every event of one flow carries that flow's requestId, and there is at least one
function expectOneRequestId(store: ReturnType<typeof createFakeStore>, requestId = 'req-1'): void {
  expect(new Set(store.events.map((e) => e.requestId))).toEqual(new Set([requestId]));
}

describe('createExecutionPipeline', () => {
  it('throws RESOURCE_NOT_FOUND for an unknown resource', async () => {
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'RESOURCE_NOT_FOUND',
    );
  });

  it('rejects a request whose protocol is not in the resource exposedVia (http-only resource over mcp)', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' }, exposedVia: ['http'] });
    const store = createFakeStore();
    let backendCalled = false;
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: {}, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest({ protocol: 'mcp' }))).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'RESOURCE_NOT_FOUND',
    );
    expect(backendCalled).toBe(false);
    expect(store.receipts).toHaveLength(0);
  });

  it('rejects a request whose protocol is not in the resource exposedVia (mcp-only resource over http)', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' }, exposedVia: ['mcp'] });
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest({ protocol: 'http' }))).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'RESOURCE_NOT_FOUND',
    );
  });

  it('rejects a paid http-only resource invoked over mcp before any payment provider call', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
      exposedVia: ['http'],
    });
    const store = createFakeStore();
    let createRequirementCalled = false;
    const provider = createFakePaymentProvider({
      createRequirement: async (ctx) => {
        createRequirementCalled = true;
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
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest({ protocol: 'mcp' }))).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'RESOURCE_NOT_FOUND',
    );
    expect(createRequirementCalled).toBe(false);
  });

  it('throws INPUT_INVALID for input that fails the resource schema', async () => {
    const resource = makeResource({
      id: 'res-1',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    });
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest({ input: {} }))).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
    );
  });

  it('an empty path-parameter value on a paid resource is rejected before payment, with no reservePaymentAttempt call', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
      handler: { type: 'http', method: 'GET', url: 'http://backend.local/api/report/{city}' },
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        additionalProperties: false,
      },
    });
    let reserveCalls = 0;
    const store = createFakeStore({
      reservePaymentAttempt: async () => {
        reserveCalls += 1;
        throw new Error('should never be called');
      },
    });
    let createRequirementCalls = 0;
    const provider = createFakePaymentProvider({
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
    });
    let backendCalled = false;
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: {}, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(
        makeRequest({ input: { city: '' }, payment: { method: 'x402', payload: 'proof' } }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
    );

    // Rejected before any payment provider is touched
    expect(createRequirementCalls).toBe(0);
    expect(reserveCalls).toBe(0);
    expect(backendCalled).toBe(false);
    expect(store.attempts.size).toBe(0);
  });

  it('a MISSING path-parameter value on a paid resource is rejected before payment, with no reservePaymentAttempt call', async () => {
    // A schema that never declares {city} means no caller can supply it.
    // Config refuses that shape at load; the pipeline must still refuse a
    // hand-built CommerceResource before payment.
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
      handler: { type: 'http', method: 'GET', url: 'http://backend.local/api/report/{city}' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
    let reserveCalls = 0;
    const store = createFakeStore({
      reservePaymentAttempt: async () => {
        reserveCalls += 1;
        throw new Error('should never be called');
      },
    });
    let createRequirementCalls = 0;
    const provider = createFakePaymentProvider({
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
    });
    let backendCalled = false;
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: {}, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ input: {}, payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
    );

    expect(createRequirementCalls).toBe(0);
    expect(reserveCalls).toBe(0);
    expect(backendCalled).toBe(false);
    expect(store.attempts.size).toBe(0);
  });

  it('control: a correctly declared REQUIRED path parameter still pays and delivers', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
      handler: { type: 'http', method: 'GET', url: 'http://backend.local/api/report/{city}' },
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider();
    let backendCalled = false;
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      // Tests that a declared, required param clears validateBackendRequestShape
      // and reaches the backend. URL templating itself is covered by
      // backend-http.test.ts.
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: { ok: true }, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(
      makeRequest({ input: { city: 'Berlin' }, payment: { method: 'x402', payload: 'proof' } }),
    );
    expect(outcome.kind).toBe('delivered');
    expect((outcome as DeliveredOutcome).payment?.status).toBe('settled');
    expect(backendCalled).toBe(true);
    expect(store.receipts).toHaveLength(1);
  });

  it('delivers a free resource end-to-end', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore();
    const backend = createFakeBackendExecutor(async () => ({
      status: 200,
      headers: { 'x-demo': '1' },
      body: { weather: 'sunny' },
      durationMs: 12,
    }));
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend,
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest());
    expect(outcome.kind).toBe('delivered');
    const delivered = outcome as DeliveredOutcome;
    expect(delivered.backendStatus).toBe(200);
    expect(delivered.body).toEqual({ weather: 'sunny' });
    expect(delivered.payment).toBeUndefined();
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]?.resourceId).toBe('res-1');
    expect(eventTypes(store)).toEqual([
      'resource.requested',
      'backend.called',
      'resource.delivered',
    ]);
    expectOneRequestId(store);
  });

  it('never touches a payment provider for a free resource, even when the request carries a proof', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'free' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const providerCalls: string[] = [];
    const refuse = (method: string) => async (): Promise<never> => {
      providerCalls.push(method);
      throw new Error(`${method} must not run for a free resource`);
    };
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [
        createFakePaymentProvider({
          createRequirement: refuse('createRequirement'),
          verify: refuse('verify'),
          settle: refuse('settle'),
        }),
      ],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(
      makeRequest({ payment: { method: 'x402', payload: 'proof' } }),
    );

    expect(outcome.kind).toBe('delivered');
    expect(providerCalls).toEqual([]);
    expect((outcome as DeliveredOutcome).payment).toBeUndefined();
    expect(store.receipts[0]?.payment).toBeUndefined();
    expect(store.attempts.size).toBe(0);
  });

  it('leaves non-object input (array, primitive) untouched by the _payment stripping step', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore();
    let seenInput: unknown;
    const backend = createFakeBackendExecutor(async (_h, req) => {
      seenInput = req.input;
      return { status: 200, headers: {}, body: {}, durationMs: 1 };
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend,
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await pipeline.execute(makeRequest({ input: [1, 2, 3] }));
    expect(seenInput).toEqual([1, 2, 3]);

    await pipeline.execute(makeRequest({ requestId: 'req-2', input: 'a-string' }));
    expect(seenInput).toBe('a-string');
  });

  it('keeps non-_payment keys while stripping _payment from an object with multiple fields', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore();
    let seenInput: unknown;
    const backend = createFakeBackendExecutor(async (_h, req) => {
      seenInput = req.input;
      return { status: 200, headers: {}, body: {}, durationMs: 1 };
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend,
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await pipeline.execute(makeRequest({ input: { city: 'Berlin', _payment: 'proof' } }));
    expect(seenInput).toEqual({ city: 'Berlin' });
  });

  it('strips a "__proto__" input key before it ever reaches validation or the backend', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore();
    let seenInput: unknown;
    const backend = createFakeBackendExecutor(async (_h, req) => {
      seenInput = req.input;
      return { status: 200, headers: {}, body: {}, durationMs: 1 };
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend,
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const input = JSON.parse('{"city":"Berlin","__proto__":{"isAdmin":true}}');
    const outcome = await pipeline.execute(makeRequest({ input }));
    expect(outcome.kind).toBe('delivered');
    expect(seenInput).toEqual({ city: 'Berlin' });
    expect(Object.keys(seenInput as object)).toEqual(['city']);
    // The forwarded object's own prototype must be untouched, not swapped to
    // the attacker-supplied {isAdmin: true}
    expect(Object.getPrototypeOf(seenInput)).toBe(Object.prototype);
  });

  it('strips the reserved _payment field before validating input against additionalProperties:false', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'free' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest({ input: { _payment: 'whatever' } }));
    expect(outcome.kind).toBe('delivered');
  });

  it('strips every reserved field, not only _payment, before validating input', async () => {
    // Defense in depth. Adapters lift these out already, so reaching here
    // means one of them stopped doing so - and the closed schema below would
    // then turn a gateway-reserved field into the caller's INPUT_INVALID.
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'free' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
    const store = createFakeStore();
    const backendInputs: unknown[] = [];
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(async (_handler, request) => {
        backendInputs.push(request.input);
        return { status: 200, headers: {}, body: { ok: true }, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(
      makeRequest({
        input: { _payment: 'whatever', _authorization: { method: 'ap2', payload: 'proof' } },
      }),
    );

    expect(outcome.kind).toBe('delivered');
    expect(backendInputs).toEqual([{}]);
  });

  it('returns a PaymentRequiredOutcome and emits payment.required when no proof is supplied', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest());
    expect(outcome.kind).toBe('payment-required');
    const required = outcome as PaymentRequiredOutcome;
    expect(required.requirement.amount).toBe('0.01');
    expect(eventTypes(store)).toEqual(['resource.requested', 'payment.required']);
    expect(store.receipts).toHaveLength(0);
  });

  it('a resource declaring both rails is served by the one it has a provider for', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['mpp', 'x402'],
    });
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [createFakePaymentProvider({ name: 'x402' })],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest());
    expect(outcome.kind).toBe('payment-required');
    // mpp is skipped because no provider is registered for it, so reaching
    // x402 is resolution rather than fallback - nothing was attempted on mpp
    expect((outcome as PaymentRequiredOutcome).requirement.provider).toBe('x402');
  });

  it('challenges on the first rail the resource lists, whatever order the providers are registered in', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['mpp', 'x402'],
    });
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [
        createFakePaymentProvider({ name: 'x402' }),
        createFakePaymentProvider({ name: 'mpp' }),
      ],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest());
    expect((outcome as PaymentRequiredOutcome).requirement.provider).toBe('mpp');
  });

  it('PAYMENT_PROVIDER_UNAVAILABLE when no configured provider matches the resource payment methods', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['mpp'],
    });
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      // Registered, but for a rail the resource does not accept
      paymentProviders: [createFakePaymentProvider({ name: 'x402' })],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('verify() returning rejected -> PAYMENT_INVALID carrying the unused challenge, with nothing reserved, settled or delivered', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    let backendCalled = false;
    let settleCalls = 0;
    const envelope = { x402Version: 2, accepts: [{ scheme: 'exact' }] };
    const provider = createFakePaymentProvider({
      challengeEnvelope: envelope,
      // A provider may derive the replay key before it rejects, so the key
      // alone must not carry a refused proof on to settlement
      verify: async () => ({
        status: 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        rejectionReason: 'bad-signature',
        replayKey: 'replay-key-1',
      }),
      settle: async () => {
        settleCalls += 1;
        return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: {}, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const error = await pipeline
      .execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } }))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isCommerceError(error) && error.code).toBe('PAYMENT_INVALID');
    expect(isCommerceError(error) && error.message).toBe('bad-signature');
    // Pass the unused challenge and refusal reason to the HTTP adapter so it
    // can send a new 402 challenge
    expect(isCommerceError(error) && error.details).toEqual({
      challenge: envelope,
      reason: 'bad-signature',
    });
    expect(store.attempts.size).toBe(0);
    expect(settleCalls).toBe(0);
    expect(backendCalled).toBe(false);
    expect(store.receipts).toHaveLength(0);
    expect(eventTypes(store)).toEqual(['resource.requested', 'payment.rejected']);
    expect(store.events[1]?.data).toEqual({ reason: 'bad-signature' });
    expectOneRequestId(store);
  });

  it('replay: second request with the same replayKey -> PAYMENT_REPLAYED, no settle call', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    let settleCalls = 0;
    const provider = createFakePaymentProvider({
      settle: async () => {
        settleCalls += 1;
        return {
          status: 'settled',
          provider: 'x402',
          amount: '0.01',
          currency: 'USDC',
          externalReference: 'tx',
        };
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const request = makeRequest({ payment: { method: 'x402', payload: 'proof' } });
    const first = await pipeline.execute(request);
    expect(first.kind).toBe('delivered');
    expect(settleCalls).toBe(1);

    await expect(
      pipeline.execute(
        makeRequest({ requestId: 'req-2', payment: { method: 'x402', payload: 'proof' } }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'PAYMENT_REPLAYED',
    );
    expect(settleCalls).toBe(1);
  });

  it('an untyped reservePaymentAttempt failure maps to STORAGE_ERROR, never mislabeled PAYMENT_REPLAYED', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore({
      reservePaymentAttempt: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    let settleCalls = 0;
    let backendCalled = false;
    const provider = createFakePaymentProvider({
      settle: async () => {
        settleCalls += 1;
        return { status: 'settled', provider: 'x402', amount: '0.01', currency: 'USDC' };
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: {}, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'STORAGE_ERROR',
    );
    // Without a reservation there is no replay defense, so nothing may settle
    expect(settleCalls).toBe(0);
    expect(backendCalled).toBe(false);
    expect(store.events.at(-1)?.data).toEqual({ reason: 'STORAGE_ERROR' });
    expectOneRequestId(store);
  });

  it.each([
    ['settled', 402],
    ['rejected', 402],
    ['reserved', 409],
    ['settlement-uncertain', 409],
    // Written for any settle() throw before settlement-uncertain existed
    ['failed', 409],
    [undefined, 409],
  ] as const)(
    'returns %i for a replay when the first attempt is %s',
    async (attemptStatus, status) => {
      const resource = makeResource({
        id: 'res-1',
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        paymentMethods: ['x402'],
      });
      const { CommerceError } = await import('../../../../src/core/errors');
      const store = createFakeStore({
        // Simulate a duplicate whose first-attempt status is unavailable
        reservePaymentAttempt: async () => {
          throw new CommerceError('PAYMENT_REPLAYED', 'already reserved', {
            ...(attemptStatus !== undefined ? { details: { attemptStatus } } : {}),
          });
        },
      });
      const envelope = { x402Version: 2, accepts: [{ scheme: 'exact' }] };
      const pipeline = createExecutionPipeline({
        resources: createResourceRegistry([resource]),
        paymentProviders: [createFakePaymentProvider({ challengeEnvelope: envelope })],
        store,
        backend: createFakeBackendExecutor(),
        events: store,
        logger: createCapturingLogger(),
        clock: createFakeClock(),
        ids: createFakeIdGenerator(),
      });

      const error = await pipeline
        .execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(isCommerceError(error) && error.code).toBe('PAYMENT_REPLAYED');
      expect(isCommerceError(error) && error.httpStatus).toBe(status);
      // Only a finished attempt receives a new challenge
      const challenge = isCommerceError(error) ? error.details?.['challenge'] : undefined;
      expect(challenge).toEqual(status === 402 ? envelope : undefined);
    },
  );

  it('settle() rejected -> PAYMENT_SETTLEMENT_FAILED, no backend call', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    let backendCalled = false;
    const provider = createFakePaymentProvider({
      settle: async () => ({
        status: 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        rejectionReason: 'insufficient-funds',
      }),
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: {}, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'PAYMENT_SETTLEMENT_FAILED',
    );
    expect(backendCalled).toBe(false);
    expect(store.receipts).toHaveLength(0);
  });

  it('settle() rejected without a rejectionReason still fails closed with a default message', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider({
      settle: async () => ({
        status: 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
      }),
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'PAYMENT_SETTLEMENT_FAILED',
    );
    const attempt = [...store.attempts.values()][0];
    expect(attempt?.status).toBe('rejected');
  });

  it('settle() succeeding without an externalReference still delivers', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider({
      settle: async () => ({
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
      }),
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(
      makeRequest({ payment: { method: 'x402', payload: 'proof' } }),
    );
    expect(outcome.kind).toBe('delivered');
    const attempt = [...store.attempts.values()][0];
    expect(attempt?.status).toBe('settled');
    expect(attempt?.externalReference).toBeUndefined();
  });

  it('provider throwing PAYMENT_PROVIDER_UNAVAILABLE during verify propagates that code', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const { CommerceError } = await import('../../../../src/core/errors');
    const provider = createFakePaymentProvider({
      verify: async () => {
        throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'facilitator down');
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    // No verdict was reached, so nothing is held against the payer and the
    // client may retry the same proof
    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE' && error.retryable,
    );
    expect(store.attempts.size).toBe(0);
  });

  it('a generic thrown error during verify is mapped to PAYMENT_INVALID', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const envelope = { x402Version: 2, accepts: [{ scheme: 'exact' }] };
    const provider = createFakePaymentProvider({
      challengeEnvelope: envelope,
      verify: async () => {
        throw new Error('network blip');
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        error.code === 'PAYMENT_INVALID' &&
        JSON.stringify(error.details) === JSON.stringify({ challenge: envelope }),
    );
    expect(store.attempts.size).toBe(0);
  });

  it("an untyped verify() error's message never reaches the client, even when it carries a secret", async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const secret =
      'facilitator key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478 rejected by 10.9.9.9';
    const provider = createFakePaymentProvider({
      verify: async () => {
        throw new Error(secret);
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    try {
      await pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } }));
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (isCommerceError(error)) {
        expect(error.code).toBe('PAYMENT_INVALID');
        expect(error.message).not.toContain(secret);
        const { toErrorEnvelope } = await import('../../../../src/core/domain/wire');
        const envelope = toErrorEnvelope(error);
        expect(JSON.stringify(envelope)).not.toContain(secret);
        // The original detail is not lost, only kept off the client-visible surface
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as Error).message).toBe(secret);
      }
    }
  });

  it('a typed CommerceError thrown by verify() (e.g. STORAGE_ERROR) is rethrown as-is, not flattened to PAYMENT_INVALID', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const { CommerceError } = await import('../../../../src/core/errors');
    const provider = createFakePaymentProvider({
      verify: async () => {
        throw new CommerceError('STORAGE_ERROR', 'ledger unreachable');
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'STORAGE_ERROR',
    );
  });

  it('createRequirement() throwing maps to PAYMENT_PROVIDER_UNAVAILABLE and fails closed (no backend call)', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    let backendCalled = false;
    const provider = createFakePaymentProvider({
      createRequirement: async () => {
        throw new Error('RPC pool exhausted at postgres://svc:hunter2@10.1.2.3:5432/payments');
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(async () => {
        backendCalled = true;
        return { status: 200, headers: {}, body: {}, durationMs: 1 };
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    try {
      await pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } }));
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (isCommerceError(error)) {
        expect(error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
        expect(error.message).not.toContain('hunter2');
      }
    }
    expect(backendCalled).toBe(false);
    expect(store.receipts).toHaveLength(0);
  });

  it('missing replayKey on a verified result -> PAYMENT_INVALID', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider({
      verify: async () => ({
        status: 'verified',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
      }),
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'PAYMENT_INVALID',
    );
  });

  it('backend timeout propagates BACKEND_TIMEOUT after successful free resolution', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore();
    const { CommerceError } = await import('../../../../src/core/errors');
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(async () => {
        throw new CommerceError('BACKEND_TIMEOUT', 'timed out');
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_TIMEOUT',
    );
    expect(eventTypes(store)).toEqual(['resource.requested', 'backend.failed']);
  });

  it('backend 404/500 propagates BACKEND_ERROR', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore();
    const { CommerceError } = await import('../../../../src/core/errors');
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(async () => {
        throw new CommerceError('BACKEND_ERROR', 'server exploded', { details: { status: 500 } });
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_ERROR',
    );
  });

  it('backend failure after settlement still persists the payment attempt, saves a failed-delivery receipt, and tells the buyer the payment settled', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider();
    const { CommerceError } = await import('../../../../src/core/errors');
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(async () => {
        throw new CommerceError('BACKEND_ERROR', 'backend down after payment', {
          details: { status: 500 },
        });
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    let thrown: unknown;
    try {
      await pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } }));
      expect.unreachable();
    } catch (error) {
      thrown = error;
    }
    expect(isCommerceError(thrown)).toBe(true);
    if (!isCommerceError(thrown)) throw new Error('unreachable');
    expect(thrown.code).toBe('BACKEND_ERROR');

    // The buyer is told the payment settled, with its settlement reference
    expect(thrown.details).toEqual({
      payment: {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        externalReference: 'tx-1',
        payer: '0xBUYER',
      },
    });

    const attempt = [...store.attempts.values()][0];
    expect(attempt?.status).toBe('settled');
    expect(eventTypes(store)).toEqual([
      'resource.requested',
      'payment.verified',
      'payment.settled',
      'backend.failed',
    ]);

    // The merchant's ledger records the paid, undelivered request the buyer
    // was told about
    expect(store.receipts).toHaveLength(1);
    const receipt = store.receipts[0];
    expect(receipt?.backendStatus).toBe(500);
    expect(receipt?.payment?.externalReference).toBe('tx-1');
    expect(receipt?.metadata).toEqual({ delivered: false, backendErrorCode: 'BACKEND_ERROR' });
  });

  it('a backend timeout after settlement records the undelivered receipt with no backend status', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const { CommerceError } = await import('../../../../src/core/errors');
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [createFakePaymentProvider()],
      store,
      backend: createFakeBackendExecutor(async () => {
        throw new CommerceError('BACKEND_TIMEOUT', 'timed out', {
          details: { timeoutMs: 5, durationMs: 5 },
        });
      }),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        error.code === 'BACKEND_ERROR' &&
        (error.details?.['payment'] as { status?: string } | undefined)?.status === 'settled',
    );
    // The merchant never answered, so the receipt claims no status it did not see
    expect(store.receipts[0]?.backendStatus).toBe(0);
    expect(store.receipts[0]?.metadata).toEqual({
      delivered: false,
      backendErrorCode: 'BACKEND_TIMEOUT',
    });
  });

  it('full event sequence and shared requestId for a successful paid flow', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(
      makeRequest({ payment: { method: 'x402', payload: 'proof' } }),
    );
    expect(outcome.kind).toBe('delivered');
    const delivered = outcome as DeliveredOutcome;
    expect(delivered.payment?.status).toBe('settled');
    expect(eventTypes(store)).toEqual([
      'resource.requested',
      'payment.verified',
      'payment.settled',
      'backend.called',
      'resource.delivered',
    ]);
    expectOneRequestId(store);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]?.payment?.status).toBe('settled');
  });

  it('defends against dynamic pricing reaching the pipeline (config should already reject it)', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'dynamic', resolver: 'not-supported' },
    });
    const store = createFakeStore();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(pipeline.execute(makeRequest())).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'CONFIG_INVALID',
    );
  });

  it('settle() throwing -> PAYMENT_SETTLEMENT_FAILED, attempt marked settlement-uncertain', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const provider = createFakePaymentProvider({
      settle: async () => {
        throw new Error('facilitator unreachable');
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    let thrown: unknown;
    try {
      await pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } }));
      expect.unreachable();
    } catch (error) {
      thrown = error;
    }
    expect(isCommerceError(thrown)).toBe(true);
    if (!isCommerceError(thrown)) throw new Error('unreachable');
    expect(thrown.code).toBe('PAYMENT_SETTLEMENT_FAILED');

    // No hash to show, but "we never heard back" is not "nothing moved". The
    // buyer is told the outcome is unknown, with the requestId to follow up on.
    expect(thrown.message).toBe('Settlement could not be confirmed');
    expect(thrown.details).toEqual({ settlementUncertain: true, payer: '0xBUYER' });
    const { toErrorEnvelope } = await import('../../../../src/core/domain/wire');
    const envelope = toErrorEnvelope(thrown);
    expect(envelope.details).toEqual({ settlementUncertain: true, payer: '0xBUYER' });
    expect(envelope.requestId).toBe('req-1');
    // Not retryable: the first payment may have landed, so the client must not
    // pay again
    expect(envelope.retryable).toBe(false);

    const attempt = [...store.attempts.values()][0];
    expect(attempt?.status).toBe('settlement-uncertain');
    expect(attempt?.externalReference).toBeUndefined();
    expect(store.receipts).toHaveLength(0);
    expect(eventTypes(store)).toEqual([
      'resource.requested',
      'payment.verified',
      'payment.rejected',
    ]);
    expect(store.events[2]?.data).toEqual({ reason: 'settlement-uncertain' });
    expectOneRequestId(store);
  });

  it('settle() throwing PAYMENT_PROVIDER_UNAVAILABLE with a transactionHash records settlement-uncertain, not failed', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const { CommerceError } = await import('../../../../src/core/errors');
    const provider = createFakePaymentProvider({
      settle: async () => {
        throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'RPC unreachable during settle()', {
          details: { transactionHash: '0xdeadbeef' },
        });
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    // Still fails closed: no delivery, client still sees a settlement failure
    let thrown: unknown;
    try {
      await pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } }));
      expect.unreachable();
    } catch (error) {
      thrown = error;
    }
    expect(isCommerceError(thrown)).toBe(true);
    if (!isCommerceError(thrown)) throw new Error('unreachable');
    expect(thrown.code).toBe('PAYMENT_SETTLEMENT_FAILED');

    // The buyer, whose funds may have moved, learns it from this envelope. The
    // hash is their own payment and public on-chain.
    expect(thrown.message).toBe('Settlement could not be confirmed');
    expect(thrown.details).toEqual({
      settlementUncertain: true,
      transactionHash: '0xdeadbeef',
      payer: '0xBUYER',
    });
    const { toErrorEnvelope } = await import('../../../../src/core/domain/wire');
    const envelope = toErrorEnvelope(thrown);
    expect(envelope.details).toEqual({
      settlementUncertain: true,
      transactionHash: '0xdeadbeef',
      payer: '0xBUYER',
    });

    // Recorded as settlement-uncertain with the hash, not as failed
    const attempt = [...store.attempts.values()][0];
    expect(attempt?.status).toBe('settlement-uncertain');
    expect(attempt?.externalReference).toBe('0xdeadbeef');
  });

  it('settle() throwing PAYMENT_PROVIDER_UNAVAILABLE with no transactionHash records settlement-uncertain', async () => {
    const resource = makeResource({
      id: 'res-1',
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      paymentMethods: ['x402'],
    });
    const store = createFakeStore();
    const { CommerceError } = await import('../../../../src/core/errors');
    const provider = createFakePaymentProvider({
      settle: async () => {
        // The facilitator took the settlement and then dropped the response,
        // so there is no hash. An absent hash is not an absent transfer.
        throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'connection reset during settle');
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [provider],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    await expect(
      pipeline.execute(makeRequest({ payment: { method: 'x402', payload: 'proof' } })),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'PAYMENT_SETTLEMENT_FAILED',
    );

    const attempt = [...store.attempts.values()][0];
    expect(attempt?.status).toBe('settlement-uncertain');
  });

  it('tolerates a non-Error thrown by a persistence call', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore({
      saveReceipt: async () => {
        throw 'boom';
      },
    });
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger: createCapturingLogger(),
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest());
    expect(outcome.kind).toBe('delivered');
  });

  it('event-sink failure does not fail an otherwise successful flow', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore();
    const failingSink = {
      emit: async () => {
        throw new Error('sink down');
      },
    };
    const logger = createCapturingLogger();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: failingSink,
      logger,
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest());
    expect(outcome.kind).toBe('delivered');
    expect(logger.errors.map((e) => e.obj['eventType'])).toEqual([
      'resource.requested',
      'backend.called',
      'resource.delivered',
    ]);
  });

  it('receipt persistence failure does not fail an otherwise successful flow, and is logged', async () => {
    const resource = makeResource({ id: 'res-1', pricing: { type: 'free' } });
    const store = createFakeStore({
      saveReceipt: async () => {
        throw new Error('disk full');
      },
    });
    const logger = createCapturingLogger();
    const pipeline = createExecutionPipeline({
      resources: createResourceRegistry([resource]),
      paymentProviders: [],
      store,
      backend: createFakeBackendExecutor(),
      events: store,
      logger,
      clock: createFakeClock(),
      ids: createFakeIdGenerator(),
    });

    const outcome = await pipeline.execute(makeRequest());
    expect(outcome.kind).toBe('delivered');
    expect(logger.errors).toEqual([
      {
        obj: { err: { message: 'disk full', name: 'Error' }, requestId: 'req-1' },
        msg: 'Persistence failed: saveReceipt',
      },
    ]);
  });
});
