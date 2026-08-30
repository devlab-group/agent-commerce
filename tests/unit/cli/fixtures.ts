import type { GatewayConfig } from '../../../src/cli/lib/config-client.js';
import type { FetchLike } from '../../../src/cli/lib/http.js';
import type { CommerceResource, PaymentAttempt, ReceiptStore } from '../../../src/core/index.js';

export function makeResource(overrides: Partial<CommerceResource> = {}): CommerceResource {
  return {
    id: overrides.id ?? 'weather',
    name: overrides.name ?? 'Get weather',
    handler: overrides.handler ?? {
      type: 'http',
      method: 'GET',
      url: 'http://localhost:3000/api/weather/{city}',
    },
    pricing: overrides.pricing ?? { type: 'free' },
    exposedVia: overrides.exposedVia ?? ['http', 'mcp'],
    paymentMethods: overrides.paymentMethods ?? [],
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides.inputSchema !== undefined ? { inputSchema: overrides.inputSchema } : {}),
    ...(overrides.outputSchema !== undefined ? { outputSchema: overrides.outputSchema } : {}),
  };
}

export function makeGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    version: 1,
    merchant: {
      id: 'demo-merchant',
      name: 'Demo Merchant',
      publicBaseUrl: 'http://localhost:8080',
    },
    server: { port: 8080, host: '0.0.0.0', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
      a2a: { enabled: false, mountPath: '/a2a' },
    },
    resources: [makeResource()],
    payments: {},
    ...overrides,
  };
}

/** Builds a fake `fetch` from an exact-URL -> Response map. Unmatched URLs reject (simulating "unreachable"). */
export function createFakeFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
): FetchLike {
  const fake = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[url];
    if (handler === undefined) {
      throw new TypeError(`fake fetch: connection refused for ${url}`);
    }
    return handler();
  };
  return fake as unknown as FetchLike;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function makeFakeReceiptStore(overrides: Partial<ReceiptStore> = {}): ReceiptStore {
  const attempts = new Map<string, PaymentAttempt>();
  return {
    init: overrides.init ?? (async () => {}),
    appendEvent: overrides.appendEvent ?? (async () => {}),
    reservePaymentAttempt:
      overrides.reservePaymentAttempt ??
      (async (reservation) => {
        const attempt: PaymentAttempt = {
          id: `attempt_${attempts.size + 1}`,
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
      }),
    updatePaymentAttempt: overrides.updatePaymentAttempt ?? (async () => {}),
    saveReceipt: overrides.saveReceipt ?? (async () => {}),
    getReceipt: overrides.getReceipt ?? (async () => undefined),
    listReceipts: overrides.listReceipts ?? (async () => []),
    countReceipts: overrides.countReceipts ?? (async () => 0),
    countUndeliveredReceipts: overrides.countUndeliveredReceipts ?? (async () => 0),
    listEvents: overrides.listEvents ?? (async () => []),
    listPaymentAttempts: overrides.listPaymentAttempts ?? (async () => []),
    descriptor: overrides.descriptor ?? {
      name: 'fake-receipt-store',
      kind: 'storage',
      implementationVersion: '0.0.0',
      supportedSpec: 'fake',
      capabilities: [],
      status: 'stable',
    },
    health:
      overrides.health ?? (async () => ({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' })),
    close: overrides.close ?? (async () => {}),
  };
}
