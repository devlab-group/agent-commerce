/**
 * Shared fakes for gateway tests. No dependency on any other area's
 * package (protocol-mcp, payment-x402, receipt-store) — everything here
 * implements the frozen core interfaces directly, as instructed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayConfig } from '../../../src/config/index.js';
import type {
  AdapterDescriptor,
  AdapterHealth,
  CommerceEvent,
  CommerceReceipt,
  HttpProtocolAdapter,
  PaymentAttempt,
  PaymentContext,
  PaymentMethodName,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSettlementContext,
  PaymentVerificationContext,
  ProtocolAdapter,
  ProtocolAdapterContext,
  ReceiptStore,
} from '../../../src/core/index.js';
import { CommerceError } from '../../../src/core/index.js';

const descriptor: AdapterDescriptor = {
  name: 'fake',
  kind: 'storage',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'n/a',
  capabilities: [],
  status: 'experimental',
};

export interface FakeStore extends ReceiptStore {
  readonly events: CommerceEvent[];
  readonly receipts: CommerceReceipt[];
  readonly attempts: Map<string, PaymentAttempt>;
  healthStatus: AdapterHealth['status'];
}

export function createFakeStore(): FakeStore {
  const events: CommerceEvent[] = [];
  const receipts: CommerceReceipt[] = [];
  const attempts = new Map<string, PaymentAttempt>();
  const store: FakeStore = {
    events,
    receipts,
    attempts,
    healthStatus: 'pass',
    async init() {},
    async appendEvent(event) {
      events.push(event);
    },
    async reservePaymentAttempt(reservation) {
      if (attempts.has(reservation.replayKey)) {
        throw new CommerceError(
          'PAYMENT_REPLAYED',
          `replay key "${reservation.replayKey}" already reserved`,
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
    },
    async updatePaymentAttempt(update) {
      const existing = attempts.get(update.replayKey);
      if (!existing) return;
      attempts.set(update.replayKey, {
        ...existing,
        status: update.status,
        ...(update.externalReference !== undefined
          ? { externalReference: update.externalReference }
          : {}),
        ...(update.rejectionReason !== undefined
          ? { rejectionReason: update.rejectionReason }
          : {}),
        updatedAt: '2026-01-01T00:00:01.000Z',
      });
    },
    async saveReceipt(receipt) {
      receipts.push(receipt);
    },
    async getReceipt(id) {
      return receipts.find((r) => r.id === id);
    },
    async listReceipts(options) {
      const list = receipts;
      return options?.limit !== undefined ? list.slice(0, options.limit) : list;
    },
    async countReceipts() {
      return receipts.length;
    },
    async countUndeliveredReceipts() {
      return receipts.filter((r) => r.backendStatus < 200 || r.backendStatus > 299).length;
    },
    async listEvents(options) {
      const list = events;
      return options?.limit !== undefined ? list.slice(0, options.limit) : list;
    },
    async listPaymentAttempts() {
      return [...attempts.values()];
    },
    descriptor: { ...descriptor, name: 'fake-store', kind: 'storage' },
    async health() {
      return { status: store.healthStatus, checkedAt: '2026-01-01T00:00:00.000Z' };
    },
    async close() {},
  };
  return store;
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
    descriptor: { ...descriptor, name: 'fake-payment', kind: 'payment' },
    createRequirement:
      options.createRequirement ??
      (async (ctx) => ({
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
        replayKey: 'replay-key-1',
      })),
    settle:
      options.settle ??
      (async () => ({
        status: 'settled',
        provider: name,
        amount: '0.01',
        currency: 'USDC',
        externalReference: 'tx-1',
      })),
    health: async () => ({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' }),
  };
}

/** A minimal, non-HTTP protocol adapter fake — started/stopped, never mounted. */
export function createFakeProtocolAdapter(
  overrides: Partial<ProtocolAdapter> = {},
): ProtocolAdapter {
  return {
    name: 'http',
    descriptor: { ...descriptor, name: 'fake-adapter', kind: 'protocol' },
    start: async () => {},
    health: async () => ({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' }),
    stop: async () => {},
    ...overrides,
  };
}

/** An HTTP-mountable protocol adapter fake that echoes a fixed response. */
export function createFakeHttpAdapter(
  overrides: Partial<HttpProtocolAdapter> = {},
): HttpProtocolAdapter {
  return {
    name: 'mcp',
    descriptor: { ...descriptor, name: 'fake-http-adapter', kind: 'protocol' },
    mountPath: '/mcp',
    start: async (_context: ProtocolAdapterContext) => {},
    health: async () => ({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' }),
    stop: async () => {},
    handleHttp: async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('fake-adapter-response');
    },
    ...overrides,
  };
}

export function makeGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
    resources: [
      {
        id: 'weather_basic',
        name: 'Basic Weather',
        description: 'Free weather lookup',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/weather/{city}' },
        pricing: { type: 'free' },
        exposedVia: ['http', 'mcp'],
        paymentMethods: [],
      },
      {
        id: 'market_report',
        name: 'Premium Market Report',
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        exposedVia: ['http', 'mcp'],
        paymentMethods: ['x402'],
      },
      {
        id: 'mcp_only',
        name: 'MCP Only Resource',
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/mcp-only' },
        pricing: { type: 'free' },
        exposedVia: ['mcp'],
        paymentMethods: [],
      },
    ],
    payments: {
      x402: {
        enabled: true,
        network: 'base-sepolia',
        rpcUrl: 'http://127.0.0.1:8545',
        asset: '0x1111111111111111111111111111111111111111',
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        maxTimeoutSeconds: 120,
        facilitator: { mode: 'local', signerPrivateKey: '0xTOTALLY_SECRET_KEY' },
      },
    },
    ...overrides,
  };
}
