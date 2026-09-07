/**
 * A real listening gateway with a real merchant behind it.
 *
 * Everything between an HTTP client and the merchant's socket is the shipped
 * code: Fastify, the ACP adapter, the execution pipeline, and the real backend
 * executor building the outbound request from `inputBindings`. Only the receipt
 * store is faked, because durable receipts are not what ACP conformance is
 * about.
 *
 * The merchant is an ordinary `node:http` server that records what it was sent,
 * so a test can assert the method, path, query and body that actually crossed
 * the wire - the one thing a mocked `BackendExecutor` cannot show.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GatewayConfig } from '../../../../src/config/index.js';
import { createGateway, type GatewayInstance } from '../../../../src/gateway/index.js';
import { createAcpAdapter } from '../../../../src/protocols/acp/index.js';
import { createFakeStore } from '../../../unit/gateway/helpers.js';

/** The official examples, vendored from the same upstream commit as the schema. */
export const ACP_EXAMPLES = JSON.parse(
  readFileSync('tests/fixtures/acp/2026-04-17/examples.agentic_checkout.json', 'utf8'),
) as Record<string, Record<string, unknown>>;

// Silences the gateway's pino instance for the run - see src/gateway/logger.ts.
process.env['NODE_ENV'] = 'test';

export const ACP_TOKEN = 'conformance-bearer-token';

export const ACP_OPERATIONS = {
  createCheckoutSession: 'acp_checkout_create',
  updateCheckoutSession: 'acp_checkout_update',
  getCheckoutSession: 'acp_checkout_get',
  completeCheckoutSession: 'acp_checkout_complete',
  cancelCheckoutSession: 'acp_checkout_cancel',
} as const;

/** What the merchant actually received. */
export interface MerchantCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

/** How the merchant should answer the next call, when a test needs something specific. */
export interface MerchantReply {
  readonly status: number;
  readonly body: unknown;
  /** Held open this long before replying, to provoke a gateway timeout. */
  readonly delayMs?: number;
}

export interface AcpStack {
  readonly url: string;
  readonly calls: readonly MerchantCall[];
  /** Answer the next call (and only the next) with this. */
  nextReply(reply: MerchantReply): void;
  close(): Promise<void>;
}

interface MerchantState {
  readonly calls: MerchantCall[];
  queued: MerchantReply | undefined;
}

/** The default merchant: conformant answers, taken from the snapshot's own examples. */
function defaultReply(method: string, path: string): MerchantReply {
  if (path.endsWith('/complete')) {
    return { status: 200, body: ACP_EXAMPLES['complete_checkout_session_response'] };
  }
  if (path.endsWith('/cancel')) {
    return { status: 200, body: ACP_EXAMPLES['cancel_checkout_session_response'] };
  }
  if (method === 'POST' && /\/checkout_sessions$/.test(path)) {
    return { status: 201, body: ACP_EXAMPLES['create_checkout_session_response'] };
  }
  if (method === 'POST') {
    return { status: 200, body: ACP_EXAMPLES['update_checkout_session_response'] };
  }
  return { status: 200, body: ACP_EXAMPLES['get_checkout_session_response'] };
}

async function startMerchant(state: MerchantState): Promise<{ server: Server; origin: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://merchant.local');
      state.calls.push({
        method: req.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      });

      const reply = state.queued ?? defaultReply(req.method ?? '', url.pathname);
      state.queued = undefined;
      const send = (): void => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

/**
 * The five checkout resources, wired the way an operator would: one resource
 * per operation, each `free`, `acp`-exposed, and binding the canonical envelope
 * onto a real merchant request through `inputBindings`.
 */
function checkoutResources(origin: string, timeoutMs: number): GatewayConfig['resources'] {
  const sessionInput = {
    type: 'object' as const,
    properties: { path: { type: 'object' }, body: { type: 'object' } },
    required: ['path'],
    additionalProperties: false,
  };
  return [
    {
      id: ACP_OPERATIONS.createCheckoutSession,
      name: 'Create checkout session',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'object' } },
        required: ['body'],
        additionalProperties: false,
      },
      handler: {
        type: 'http',
        method: 'POST',
        url: `${origin}/checkout_sessions`,
        inputBindings: { body: 'body' },
        timeoutMs,
      },
      pricing: { type: 'free' },
      exposedVia: ['acp'],
      paymentMethods: [],
    },
    {
      id: ACP_OPERATIONS.updateCheckoutSession,
      name: 'Update checkout session',
      inputSchema: sessionInput,
      handler: {
        type: 'http',
        method: 'POST',
        url: `${origin}/checkout_sessions/{checkout_session_id}`,
        inputBindings: { path: 'path', body: 'body' },
        timeoutMs,
      },
      pricing: { type: 'free' },
      exposedVia: ['acp'],
      paymentMethods: [],
    },
    {
      id: ACP_OPERATIONS.getCheckoutSession,
      name: 'Retrieve checkout session',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'object' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: {
        type: 'http',
        method: 'GET',
        url: `${origin}/checkout_sessions/{checkout_session_id}`,
        inputBindings: { path: 'path' },
        timeoutMs,
      },
      pricing: { type: 'free' },
      exposedVia: ['acp'],
      paymentMethods: [],
    },
    {
      id: ACP_OPERATIONS.completeCheckoutSession,
      name: 'Complete checkout session',
      inputSchema: sessionInput,
      handler: {
        type: 'http',
        method: 'POST',
        url: `${origin}/checkout_sessions/{checkout_session_id}/complete`,
        inputBindings: { path: 'path', body: 'body' },
        timeoutMs,
      },
      pricing: { type: 'free' },
      exposedVia: ['acp'],
      paymentMethods: [],
    },
    {
      id: ACP_OPERATIONS.cancelCheckoutSession,
      name: 'Cancel checkout session',
      inputSchema: sessionInput,
      handler: {
        type: 'http',
        method: 'POST',
        url: `${origin}/checkout_sessions/{checkout_session_id}/cancel`,
        inputBindings: { path: 'path', body: 'body' },
        timeoutMs,
      },
      pricing: { type: 'free' },
      exposedVia: ['acp'],
      paymentMethods: [],
    },
  ];
}

export interface StartAcpStackOptions {
  /** Backend timeout, lowered by the test that provokes one. */
  readonly backendTimeoutMs?: number;
}

export async function startAcpStack(options: StartAcpStackOptions = {}): Promise<AcpStack> {
  const state: MerchantState = { calls: [], queued: undefined };
  const { server, origin } = await startMerchant(state);

  const config: GatewayConfig = {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: false },
      mcp: { enabled: false, mountPath: '/mcp' },
      a2a: { enabled: false, mountPath: '/a2a' },
      acp: {
        enabled: true,
        mountPath: '/acp',
        auth: { type: 'bearer', token: ACP_TOKEN },
        idempotency: { path: ':memory:', retentionHours: 24 },
        checkout: { operations: ACP_OPERATIONS },
      },
    },
    resources: checkoutResources(origin, options.backendTimeoutMs ?? 5_000),
    payments: {},
  };

  const gateway: GatewayInstance = await createGateway({
    config,
    store: createFakeStore(),
    paymentProviders: [],
    protocolAdapters: [
      createAcpAdapter({
        mountPath: '/acp',
        token: ACP_TOKEN,
        operations: ACP_OPERATIONS,
        idempotency: { path: ':memory:', retentionHours: 24 },
      }),
    ],
  });
  const { url } = await gateway.listen();

  return {
    url,
    calls: state.calls,
    nextReply(reply) {
      state.queued = reply;
    },
    async close() {
      await gateway.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Headers a conformant ACP client sends. Individual tests override one piece. */
export function acpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${ACP_TOKEN}`,
    'api-version': '2026-04-17',
    'content-type': 'application/json',
    'idempotency-key': `idem-${Math.random().toString(36).slice(2)}`,
    ...extra,
  };
}

export interface AcpHttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

/** One request over a real socket, the way an ACP client makes it. */
export async function acpFetch(
  stack: AcpStack,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<AcpHttpResult> {
  const headers = init.headers ?? acpHeaders();
  const response = await fetch(`${stack.url}${path}`, {
    method: init.method ?? 'POST',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

export const CREATE_REQUEST = ACP_EXAMPLES['create_checkout_session_request'] as Record<
  string,
  unknown
>;
export const COMPLETE_REQUEST = ACP_EXAMPLES['complete_checkout_session_request'] as Record<
  string,
  unknown
>;
export const UPDATE_REQUEST = ACP_EXAMPLES['update_checkout_session_request'] as Record<
  string,
  unknown
>;
