/** Shared ACP adapter fixtures: the five mapped resources and a spied context. */
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { createResourceRegistry } from '../../../src/core/execution/index.js';
import type {
  CanonicalRequest,
  Clock,
  CommerceReceipt,
  CommerceResource,
  EventSink,
  ExecutionOutcome,
  ExecutionPipeline,
  IdGenerator,
  Logger,
  ProtocolAdapterContext,
  ResourceRegistry,
} from '../../../src/core/index.js';
import type { AcpAdapterOptions } from '../../../src/protocols/acp/adapter.js';
import type { AcpCheckoutOperation } from '../../../src/protocols/acp/constants.js';
import { ACP_SUCCESS_STATUS } from '../../../src/protocols/acp/response-mapping.js';

export const TOKEN = 'acp-secret-token';
export const MOUNT = '/acp';

export const ACP_OPERATIONS: Readonly<Record<AcpCheckoutOperation, string>> = {
  createCheckoutSession: 'acp_checkout_create',
  updateCheckoutSession: 'acp_checkout_update',
  getCheckoutSession: 'acp_checkout_get',
  completeCheckoutSession: 'acp_checkout_complete',
  cancelCheckoutSession: 'acp_checkout_cancel',
};

/** Free, acp-exposed, unpaid - the shape config enforces for a mapped resource. */
function checkoutResource(id: string): CommerceResource {
  return {
    id,
    name: id,
    handler: { type: 'http', method: 'POST', url: 'http://backend.local/checkout' },
    pricing: { type: 'free' },
    exposedVia: ['acp'],
    paymentMethods: [],
  };
}

export const ACP_RESOURCES: readonly CommerceResource[] =
  Object.values(ACP_OPERATIONS).map(checkoutResource);

export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

const clock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  nowIso: () => '2026-01-01T00:00:00.000Z',
  monotonicMs: () => 0,
};

const receipt: CommerceReceipt = {
  id: 'rcpt-1',
  requestId: 'acp-1',
  resourceId: 'acp_checkout_create',
  protocol: 'acp',
  deliveredAt: '2026-01-01T00:00:00.000Z',
  backendStatus: 200,
  durationMs: 3,
};

/**
 * The official examples, vendored from the same upstream commit as the schema.
 * Merchant answers in these tests are ACP's own documents, not ones we wrote to
 * match our reading of it.
 */
export const ACP_EXAMPLES = JSON.parse(
  readFileSync('tests/fixtures/acp/2026-04-17/examples.agentic_checkout.json', 'utf8'),
) as Record<string, Record<string, unknown>>;

export function sessionDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...ACP_EXAMPLES['get_checkout_session_response'], ...overrides };
}

/** A delivered outcome carrying `body` as the merchant backend's document. */
export function delivered(body: unknown, backendStatus = 200): ExecutionOutcome {
  return {
    kind: 'delivered',
    requestId: 'acp-1',
    resourceId: 'acp_checkout_create',
    backendStatus,
    body,
    receipt,
    durationMs: 3,
  };
}

/** What a conformant merchant backend returns for `operation`. */
export function deliveredFor(operation: AcpCheckoutOperation): ExecutionOutcome {
  const body =
    operation === 'completeCheckoutSession'
      ? ACP_EXAMPLES['complete_checkout_session_response']
      : sessionDocument();
  return delivered(body, ACP_SUCCESS_STATUS[operation]);
}

export const paymentRequired: ExecutionOutcome = {
  kind: 'payment-required',
  requestId: 'acp-1',
  resourceId: 'acp_checkout_create',
  requirement: {
    id: 'req-1',
    requestId: 'acp-1',
    resourceId: 'acp_checkout_create',
    provider: 'x402',
    amount: '0.01',
    currency: 'USDC',
    destination: '0x1111111111111111111111111111111111111111',
    network: 'eip155:84532',
    asset: '0x2222222222222222222222222222222222222222',
    expiresAt: '2026-01-01T00:05:00.000Z',
    challenge: { provider: 'x402', version: '2', accepts: [{ scheme: 'exact' }] },
  },
};

/**
 * A context whose pipeline is spied. By default it refuses to be called, so a
 * test that expects no execution says so by not overriding the outcome.
 */
export function setup(outcome?: ExecutionOutcome | Error) {
  const execute = vi.fn(async (_request: CanonicalRequest): Promise<ExecutionOutcome> => {
    if (outcome === undefined) throw new Error('the pipeline must not be reached');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const context: ProtocolAdapterContext = {
    pipeline: { execute } as ExecutionPipeline,
    resources: createResourceRegistry(ACP_RESOURCES) as ResourceRegistry,
    events: { emit: async () => {} } as EventSink,
    logger: NOOP_LOGGER,
    clock,
    ids: (() => {
      let n = 0;
      return { next: (prefix?: string) => `${prefix ?? 'id'}-${++n}` };
    })() as IdGenerator,
    publicBaseUrl: 'https://merchant.example.com',
  };
  return { execute, context };
}

export function adapterOptions(overrides: Partial<AcpAdapterOptions> = {}): AcpAdapterOptions {
  return {
    mountPath: MOUNT,
    token: TOKEN,
    operations: ACP_OPERATIONS,
    idempotency: { path: ':memory:', retentionHours: 24 },
    ...overrides,
  };
}

/** The one canonical request the pipeline was handed. */
export function firstRequest(execute: { mock: { calls: unknown[][] } }): CanonicalRequest {
  const request = execute.mock.calls[0]?.[0];
  if (request === undefined) throw new Error('pipeline was never called');
  return request as CanonicalRequest;
}
