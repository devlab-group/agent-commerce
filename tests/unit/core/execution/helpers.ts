/**
 * Shared fakes for execution-pipeline tests. No dependency on any other
 * other area's internals — everything here implements the frozen core interfaces
 * directly.
 */
import type {
  AdapterDescriptor,
  BackendExecutor,
  BackendHandler,
  BackendRequest,
  BackendResponse,
  Clock,
  CommerceEvent,
  CommerceReceipt,
  CommerceResource,
  EventSink,
  IdGenerator,
  Logger,
  PaymentAttempt,
  PaymentContext,
  PaymentMethodName,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSettlementContext,
  PaymentVerificationContext,
  ReceiptStore,
} from '../../../../src/core/index.js';
import { CommerceError } from '../../../../src/core/index.js';

export function createFakeClock(startIso = '2026-01-01T00:00:00.000Z'): Clock {
  let counter = 0;
  return {
    now: () => new Date(startIso),
    nowIso: () => startIso,
    monotonicMs: () => {
      counter += 1;
      return counter;
    },
  };
}

export function createFakeIdGenerator(): IdGenerator {
  let n = 0;
  return {
    next: (prefix?: string) => `${prefix ?? 'id'}-${++n}`,
  };
}

const fakeDescriptor: AdapterDescriptor = {
  name: 'fake',
  kind: 'storage',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'n/a',
  capabilities: [],
  status: 'experimental',
};

/**
 * Doubles as a `ReceiptStore` (via `appendEvent`) and, for test convenience, an
 * `EventSink` (via `emit`, which just delegates to `appendEvent`) so a single
 * fake can be passed as both `store` and `events` to the pipeline.
 */
export interface FakeStore extends ReceiptStore, EventSink {
  readonly events: CommerceEvent[];
  readonly receipts: CommerceReceipt[];
  readonly attempts: Map<string, PaymentAttempt>;
}

export interface FakeStoreOptions {
  readonly reservePaymentAttempt?: ReceiptStore['reservePaymentAttempt'];
  readonly appendEvent?: ReceiptStore['appendEvent'];
  readonly saveReceipt?: ReceiptStore['saveReceipt'];
  readonly updatePaymentAttempt?: ReceiptStore['updatePaymentAttempt'];
}

export function createFakeStore(options: FakeStoreOptions = {}): FakeStore {
  const events: CommerceEvent[] = [];
  const receipts: CommerceReceipt[] = [];
  const attempts = new Map<string, PaymentAttempt>();

  const defaultReserve: ReceiptStore['reservePaymentAttempt'] = async (reservation) => {
    if (attempts.has(reservation.replayKey)) {
      throw new CommerceError(
        'PAYMENT_REPLAYED',
        `replay key "${reservation.replayKey}" already reserved`,
        {
          details: { replayKey: reservation.replayKey },
        },
      );
    }
    const attempt: PaymentAttempt = {
      id: `attempt-${attempts.size + 1}`,
      requestId: reservation.requestId,
      resourceId: reservation.resourceId,
      provider: reservation.provider,
      replayKey: reservation.replayKey,
      status: 'reserved',
      amount: reservation.amount,
      currency: reservation.currency,
      ...(reservation.payer !== undefined ? { payer: reservation.payer } : {}),
      ...(reservation.payee !== undefined ? { payee: reservation.payee } : {}),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    attempts.set(reservation.replayKey, attempt);
    return attempt;
  };

  const defaultUpdate: ReceiptStore['updatePaymentAttempt'] = async (update) => {
    const existing = attempts.get(update.replayKey);
    if (!existing) return;
    attempts.set(update.replayKey, {
      ...existing,
      status: update.status,
      ...(update.externalReference !== undefined
        ? { externalReference: update.externalReference }
        : {}),
      ...(update.rejectionReason !== undefined ? { rejectionReason: update.rejectionReason } : {}),
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
  };

  const appendEvent: ReceiptStore['appendEvent'] =
    options.appendEvent ??
    (async (event) => {
      events.push(event);
    });

  const store: FakeStore = {
    events,
    receipts,
    attempts,
    async init() {},
    appendEvent,
    emit: appendEvent,
    reservePaymentAttempt: options.reservePaymentAttempt ?? defaultReserve,
    updatePaymentAttempt: options.updatePaymentAttempt ?? defaultUpdate,
    saveReceipt:
      options.saveReceipt ??
      (async (receipt) => {
        receipts.push(receipt);
      }),
    async getReceipt(id) {
      return receipts.find((r) => r.id === id);
    },
    async listReceipts() {
      return receipts;
    },
    async countReceipts() {
      return receipts.length;
    },
    async countUndeliveredReceipts() {
      return receipts.filter((r) => r.backendStatus < 200 || r.backendStatus > 299).length;
    },
    async listEvents() {
      return events;
    },
    async listPaymentAttempts() {
      return [...attempts.values()];
    },
    descriptor: fakeDescriptor,
    async health() {
      return { status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' };
    },
    async close() {},
  };

  return store;
}

export const NOOP_TEST_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_TEST_LOGGER,
};

export function createCapturingLogger(): Logger & {
  errors: Array<{ obj: Record<string, unknown>; msg?: string }>;
} {
  const errors: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
  const logger: Logger & { errors: typeof errors } = {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (obj, msg) => {
      errors.push({ obj, ...(msg !== undefined ? { msg } : {}) });
    },
    child: () => logger,
  };
  return logger;
}

export interface FakePaymentProviderOptions {
  readonly name?: PaymentMethodName;
  readonly createRequirement?: (ctx: PaymentContext) => Promise<PaymentRequirement>;
  readonly verify?: (ctx: PaymentVerificationContext) => Promise<PaymentResult>;
  readonly settle?: (ctx: PaymentSettlementContext) => Promise<PaymentResult>;
}

export function createFakePaymentProvider(
  options: FakePaymentProviderOptions = {},
): PaymentProvider {
  const name = options.name ?? 'x402';
  return {
    name,
    descriptor: fakeDescriptor,
    createRequirement:
      options.createRequirement ??
      (async (ctx: PaymentContext) => ({
        id: 'requirement-1',
        requestId: ctx.requestId,
        resourceId: ctx.resource.id,
        provider: name,
        amount: ctx.amount,
        currency: ctx.currency,
        destination: '0xMERCHANT',
        challenge: { provider: name, version: '1', accepts: [{ scheme: 'exact' }] },
      })),
    verify:
      options.verify ??
      (async () => ({
        status: 'verified',
        provider: name,
        amount: '0.01',
        currency: 'USDC',
        payer: '0xBUYER',
        payee: '0xMERCHANT',
        replayKey: 'replay-key-1',
      })),
    settle:
      options.settle ??
      (async () => ({
        status: 'settled',
        provider: name,
        amount: '0.01',
        currency: 'USDC',
        payer: '0xBUYER',
        payee: '0xMERCHANT',
        externalReference: 'tx-1',
      })),
    health: async () => ({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' }),
  };
}

export function createFakeBackendExecutor(
  impl?: (handler: BackendHandler, request: BackendRequest) => Promise<BackendResponse>,
): BackendExecutor {
  return {
    call:
      impl ??
      (async () => ({
        status: 200,
        headers: {},
        body: { ok: true },
        durationMs: 5,
      })),
  };
}

export function makeResource(overrides: Partial<CommerceResource> = {}): CommerceResource {
  return {
    id: 'res-1',
    name: 'Test Resource',
    handler: { type: 'http', method: 'GET', url: 'http://backend.local/api' },
    pricing: { type: 'free' },
    exposedVia: ['http'],
    paymentMethods: [],
    ...overrides,
  };
}
