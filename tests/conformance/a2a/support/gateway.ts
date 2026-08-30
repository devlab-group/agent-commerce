/**
 * A real, listening gateway for the SDK to talk to.
 *
 * The official client uses global `fetch` against a URL, so unlike the
 * `inject()`-based integration tests this suite needs a socket. Everything
 * below the adapter is the real thing — gateway, pipeline, A2A adapter — with
 * the merchant backend and the receipt store faked, since neither is what the
 * protocol conformance of this endpoint depends on.
 */
import { createServer } from 'node:net';
import type { GatewayConfig } from '../../../../src/config/index.js';
import type {
  AdapterDescriptor,
  BackendExecutor,
  CommerceEvent,
  CommerceReceipt,
  PaymentAttempt,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSettlementContext,
  PaymentVerificationContext,
  ReceiptStore,
} from '../../../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../../../src/gateway/index.js';
import { createA2aAdapter } from '../../../../src/protocols/a2a/index.js';

const descriptor: AdapterDescriptor = {
  name: 'fake-store',
  kind: 'storage',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'n/a',
  capabilities: [],
  status: 'experimental',
};

function createFakeStore(): ReceiptStore {
  const events: CommerceEvent[] = [];
  const receipts: CommerceReceipt[] = [];
  const attempts = new Map<string, PaymentAttempt>();
  return {
    async init() {},
    async appendEvent(event) {
      events.push(event);
    },
    async reservePaymentAttempt(reservation) {
      const attempt: PaymentAttempt = {
        id: `attempt-${attempts.size + 1}`,
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
      attempts.set(reservation.replayKey, attempt);
      return attempt;
    },
    async updatePaymentAttempt() {},
    async saveReceipt(receipt) {
      receipts.push(receipt);
    },
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
      return 0;
    },
    async listEvents() {
      return events;
    },
    async listPaymentAttempts() {
      return [...attempts.values()];
    },
    async health() {
      return { status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' };
    },
    async close() {},
    descriptor,
  };
}

/** Fixed merchant response, so an assertion about the artifact is about the artifact. */
export const MERCHANT_BODY = { city: 'Berlin', forecast: 'sunny', celsius: 21 };

/** The only proof the fake provider accepts. */
export const VALID_PROOF = 'valid-proof';

/**
 * Counts merchant calls, because "was this delivered?" is the only question
 * that matters for a paywall. A console line saying payment succeeded proves
 * nothing; a backend call count of 0 before payment and 1 after does.
 */
function countingBackend(): BackendExecutor & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async call() {
      calls += 1;
      return { status: 200, body: MERCHANT_BODY, headers: {}, durationMs: 1 };
    },
  };
}

const paymentDescriptor: AdapterDescriptor = {
  name: 'fake-x402',
  kind: 'payment',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'x402/v2',
  capabilities: [],
  status: 'experimental',
};

/**
 * Verification and settlement live here, not in the adapter — the whole point
 * of the assertions in the paid suite is that the A2A code never decides
 * whether a proof is good. `unverifiable` models a provider that cannot reach
 * its facilitator: a throw, never a rejection, so the payer is not blamed for
 * our outage.
 */
function fakeProvider(): PaymentProvider & { settleCalls: () => number } {
  let settleCalls = 0;
  return {
    name: 'x402',
    descriptor: paymentDescriptor,
    settleCalls: () => settleCalls,
    createRequirement: async (ctx: PaymentContext): Promise<PaymentRequirement> => ({
      id: 'requirement-1',
      requestId: ctx.requestId,
      resourceId: ctx.resource.id,
      provider: 'x402',
      amount: ctx.amount,
      currency: ctx.currency,
      destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      network: 'eip155:84532',
      challenge: { provider: 'x402', version: '2', accepts: [{ scheme: 'exact' }] },
    }),
    verify: async (ctx: PaymentVerificationContext): Promise<PaymentResult> => {
      if (ctx.submission.payload === 'unverifiable-proof') {
        throw new Error('facilitator unreachable');
      }
      return ctx.submission.payload === VALID_PROOF
        ? {
            status: 'verified',
            provider: 'x402',
            amount: '0.01',
            currency: 'USDC',
            replayKey: `0xreplay-${settleCalls}`,
          }
        : {
            status: 'rejected',
            provider: 'x402',
            amount: '0.01',
            currency: 'USDC',
            rejectionReason: 'invalid_payment',
          };
    },
    settle: async (_ctx: PaymentSettlementContext): Promise<PaymentResult> => {
      settleCalls += 1;
      return {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        externalReference: '0xTXHASH',
        replayKey: `0xreplay-${settleCalls}`,
      };
    },
    health: async () => ({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' }),
  };
}

function config(publicBaseUrl: string): GatewayConfig {
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Weather Store', publicBaseUrl },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: false, mountPath: '/mcp' },
      a2a: { enabled: true, mountPath: '/a2a' },
    },
    resources: [
      {
        id: 'weather_basic',
        name: 'Basic Weather',
        description: 'Current weather for a city.',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
        pricing: { type: 'free' },
        exposedVia: ['a2a'],
        paymentMethods: [],
      },
      {
        id: 'market_report',
        name: 'Premium Market Report',
        description: 'Latest market analysis.',
        inputSchema: {
          type: 'object',
          properties: { symbol: { type: 'string' } },
          required: ['symbol'],
          additionalProperties: false,
        },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        exposedVia: ['a2a'],
        paymentMethods: ['x402'],
      },
      {
        id: 'http_only',
        name: 'HTTP Only',
        inputSchema: { type: 'object', properties: {} },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/http-only' },
        pricing: { type: 'free' },
        exposedVia: ['http'],
        paymentMethods: [],
      },
    ],
    payments: {},
  };
}

export interface RunningGateway {
  readonly gateway: GatewayInstance;
  /** Origin the SDK discovers the card from. */
  readonly url: string;
  /** Merchant backend calls so far. */
  backendCalls(): number;
  /** Successful settlements so far. */
  settleCalls(): number;
  close(): Promise<void>;
}

/**
 * A port nothing else holds. The card's `supportedInterfaces[].url` is built
 * from `publicBaseUrl` at adapter start — before `listen()` returns — and the
 * SDK POSTs to whatever that URL says, so the address has to be known up
 * front. Binding to 0 and reading it back afterwards would be too late.
 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startConformanceGateway(): Promise<RunningGateway> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const gatewayConfig: GatewayConfig = {
    ...config(url),
    server: { port, host: '127.0.0.1', allowedOrigins: [] },
  };
  const backend = countingBackend();
  const provider = fakeProvider();
  const gateway = await createGateway({
    config: gatewayConfig,
    store: createFakeStore(),
    paymentProviders: [provider],
    // Mirrors src/gateway/main.ts's composition exactly: a conformance suite
    // that wired the adapter differently from production would certify a
    // deployment nobody runs.
    protocolAdapters: [
      createA2aAdapter({
        mountPath: gatewayConfig.protocols.a2a.mountPath,
        agentName: gatewayConfig.merchant.name,
      }),
    ],
    backend,
  });
  await gateway.listen();

  return {
    gateway,
    url,
    backendCalls: backend.calls,
    settleCalls: provider.settleCalls,
    async close() {
      await gateway.close();
    },
  };
}
