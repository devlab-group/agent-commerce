/**
 * The gateway's own HTTP surface (docs/contracts.md "Gateway HTTP surface").
 * Adapter mounting (e.g. `/mcp`) is handled separately in adapters.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../config/index.js';
import type { EventBus } from '../core/execution/index.js';
import {
  type CanonicalRequest,
  type Clock,
  CommerceError,
  type ExecutionPipeline,
  type Logger,
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type PaymentProvider,
  type ReceiptStore,
  type ResourceRegistry,
  toCommerceError,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from '../core/index.js';
import { buildOperatorTokenHook } from './access-control.js';
import type { AdapterRuntime } from './adapters.js';
import { toPublicResource } from './public-resource.js';
import { createReadinessProbe } from './readiness.js';
import { buildWellKnownDocument } from './well-known.js';

const SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_SUBSCRIBERS = 32;

export interface RegisterRoutesOptions {
  readonly server: FastifyInstance;
  readonly config: GatewayConfig;
  readonly pipeline: ExecutionPipeline;
  readonly resources: ResourceRegistry;
  readonly store: ReceiptStore;
  readonly paymentProviders: readonly PaymentProvider[];
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly adapterRuntimes: readonly AdapterRuntime[];
  readonly logger: Logger;
}

export function registerRoutes(options: RegisterRoutesOptions): void {
  const { server } = options;

  // memoised + single-flight — see readiness.ts's own doc comment.
  // `options.adapterRuntimes` is mutated in place (pushed into) after
  // adapters start, so capturing the reference here is fine — the probe
  // always reads whatever it currently holds.
  const readinessProbe = createReadinessProbe({
    store: options.store,
    adapterRuntimes: options.adapterRuntimes,
    paymentProviders: options.paymentProviders,
    clock: options.clock,
    logger: options.logger,
  });

  server.get('/health', async () => ({ status: 'ok' }));

  server.get('/ready', async (_request, reply) => {
    const readiness = await readinessProbe.check();
    reply.status(readiness.ready ? 200 : 503);
    return readiness;
  });

  server.get('/.well-known/agent-commerce', async () =>
    buildWellKnownDocument({
      config: options.config,
      paymentProviders: options.paymentProviders,
      store: options.store,
      adapterRuntimes: options.adapterRuntimes,
      clock: options.clock,
    }),
  );

  server.get('/api/resources', async () => ({
    resources: options.resources.list().map(toPublicResource),
  }));

  server.post('/api/resources/:id/invoke', async (request, reply) => {
    await handleInvoke(request, reply, options);
  });

  // The admin-token gate is a per-route hook on each of these three
  // route definitions (not the global onRequest hook) — see
  // access-control.ts's file header for why. Fastify only invokes it once
  // routing has matched this exact route, so there is no percent-encoded
  // path string left for an attacker to disagree with the router about.
  const receiptsTokenHook = buildOperatorTokenHook(options.config.server.adminToken);
  const eventsTokenHook = buildOperatorTokenHook(options.config.server.adminToken);
  const eventsStreamTokenHook = buildOperatorTokenHook(options.config.server.adminToken);

  server.get('/api/receipts', { onRequest: receiptsTokenHook }, async (request, reply) => {
    try {
      const limit = parseLimit((request.query as Record<string, unknown>)['limit']);
      return { receipts: await options.store.listReceipts(limit !== undefined ? { limit } : {}) };
    } catch (error) {
      const commerceError = toCommerceError(error);
      reply.status(commerceError.httpStatus).send(toErrorEnvelope(commerceError));
      return undefined;
    }
  });

  server.get('/api/events', { onRequest: eventsTokenHook }, async (request, reply) => {
    try {
      const limit = parseLimit((request.query as Record<string, unknown>)['limit']);
      return { events: await options.store.listEvents(limit !== undefined ? { limit } : {}) };
    } catch (error) {
      const commerceError = toCommerceError(error);
      reply.status(commerceError.httpStatus).send(toErrorEnvelope(commerceError));
      return undefined;
    }
  });

  let activeSseSubscribers = 0;

  server.get('/api/events/stream', { onRequest: eventsStreamTokenHook }, (request, reply) => {
    // cap concurrent subscribers — the token hook above already
    // rejects an unauthenticated client before this handler runs; this cap
    // is about an *authenticated* client that never reads, which would
    // otherwise let Node buffer indefinitely, N times over.
    if (activeSseSubscribers >= MAX_SSE_SUBSCRIBERS) {
      reply.status(503).send({
        status: 'error',
        code: 'UNAVAILABLE',
        message: 'Too many event-stream subscribers',
      });
      return;
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Increment only after writeHead succeeds: if it threw, cleanup() below
    // was never registered, and incrementing first would leak the slot
    // permanently (after MAX_SSE_SUBSCRIBERS such leaks, the route is dead).
    activeSseSubscribers += 1;
    reply.raw.write(': connected\n\n');

    // Backpressure: write() returning false means the socket buffer
    // is full. Drop frames — not queue them — until 'drain'; an SSE feed is
    // "latest state", not a guaranteed-delivery log, and queuing unboundedly
    // is the exact memory-growth problem this is meant to avoid.
    let writable = true;
    reply.raw.on('drain', () => {
      writable = true;
    });

    // no `event:` line — the dashboard's EventSource only listens for
    // the default `message` type, and a named event never reaches onmessage
    // (onopen still fires, so the client reports "live" over a frozen feed).
    // `data:` already carries `type` in the serialised payload.
    //
    // queueMicrotask decouples fan-out from the caller: EventBus#emit() is
    // awaited inside the execution pipeline, so writing synchronously here
    // would add a slow SSE reader's latency to the payment path.
    const unsubscribe = options.eventBus.subscribe((event) => {
      queueMicrotask(() => {
        if (!writable) return;
        writable = reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    });

    const heartbeat = setInterval(() => {
      if (!writable) return;
      writable = reply.raw.write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();

    // Guards against a double-decrement if both 'close' and 'error' fire for
    // the same connection (never actually observed — 40 connect/destroy
    // cycles could not trigger it — but the guard is one line and removes
    // the question).
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
      activeSseSubscribers -= 1;
    };
    request.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    reply.hijack();
  });
}

async function handleInvoke(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RegisterRoutesOptions,
): Promise<void> {
  const resourceId = (request.params as { id: string }).id;

  try {
    const resource = options.resources.get(resourceId);
    if (!resource || !resource.exposedVia.includes('http')) {
      throw new CommerceError('RESOURCE_NOT_FOUND', `Resource "${resourceId}" was not found`, {
        requestId: request.id,
        resourceId,
      });
    }

    const paymentHeader = request.headers[PAYMENT_HEADER];
    const paymentValue = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;

    // The gateway does not decide which rail a resource uses — that's the
    // canonical resource's job (mirrors the protocol-side fix in the MCP
    // adapter). Derive the method from resource.paymentMethods instead of
    // hard-coding 'x402'. If a proof arrives for a resource with no payment
    // method configured, drop it rather than inventing a rail: the pipeline
    // will treat the resource as free (or reject it) on its own terms.
    const paymentMethod = resource.paymentMethods[0];
    const payment =
      paymentValue !== undefined && paymentMethod !== undefined
        ? { method: paymentMethod, payload: paymentValue }
        : undefined;

    const canonicalRequest: CanonicalRequest = {
      requestId: request.id,
      resourceId,
      input: request.body ?? {},
      protocol: 'http',
      receivedAt: options.clock.nowIso(),
      ...(payment !== undefined ? { payment } : {}),
    };

    const outcome = await options.pipeline.execute(canonicalRequest);

    if (outcome.kind === 'payment-required') {
      const envelope = toPaymentRequiredEnvelope(outcome);
      if (envelope.payment.envelope !== undefined) {
        // x402 v2 clients read the challenge from this header and never look
        // at the body. The body is still sent — it is richer, and it is the
        // only channel the MCP surface has — but the header is what makes an
        // off-the-shelf client able to pay.
        reply.header(PAYMENT_REQUIRED_HEADER, encodeHeaderDocument(envelope.payment.envelope));
      }
      // A challenge is per-request (fresh nonce window, fresh expiry). Caching
      // one would hand a later buyer an expired offer.
      reply.header('cache-control', 'no-store');
      reply.status(402).send(envelope);
      return;
    }

    if (outcome.payment) {
      reply.header(PAYMENT_RESPONSE_HEADER, encodePaymentSummary(outcome.payment));
    }
    reply.status(outcome.backendStatus).send(outcome.body);
  } catch (error) {
    const commerceError = toCommerceError(error);
    // a backend failure after successful settlement carries the
    // settlement summary on details.payment (pipeline.ts) — set the same
    // header the success path sets, so the buyer isn't told strictly less
    // about their own payment on the error path than on the happy path.
    const settledPayment = errorPaymentSummary(commerceError);
    if (settledPayment !== undefined) {
      reply.header(PAYMENT_RESPONSE_HEADER, encodePaymentSummary(settledPayment));
    }
    reply.status(commerceError.httpStatus).send(toErrorEnvelope(commerceError));
  }
}

interface PaymentSummary {
  readonly status: string;
  readonly provider: string;
  readonly amount: string;
  readonly currency: string;
  readonly network?: string;
  readonly externalReference?: string;
}

function errorPaymentSummary(
  error: ReturnType<typeof toCommerceError>,
): PaymentSummary | undefined {
  const payment = error.details?.['payment'];
  if (typeof payment !== 'object' || payment === null) return undefined;
  const rec = payment as Record<string, unknown>;
  const { status, provider, amount, currency, network, externalReference } = rec;
  if (
    typeof status !== 'string' ||
    typeof provider !== 'string' ||
    typeof amount !== 'string' ||
    typeof currency !== 'string'
  ) {
    return undefined;
  }
  return {
    status,
    provider,
    amount,
    currency,
    ...(typeof network === 'string' ? { network } : {}),
    ...(typeof externalReference === 'string' ? { externalReference } : {}),
  };
}

/**
 * Base64 of a JSON document, the encoding every x402 v2 payment header uses.
 *
 * Hand-rolled rather than imported from the x402 SDK on purpose: this module
 * is reachable from the package's main entry point, which must import zero
 * optional peers, and it is two lines.
 */
function encodeHeaderDocument(document: unknown): string {
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64');
}

/**
 * The settlement result, in the shape an x402 v2 client decodes from
 * `PAYMENT-RESPONSE` (`SettleResponse`), mapped from the canonical
 * {@link PaymentResult} the pipeline produced.
 *
 * `provider`, `amount` and `currency` are ours and are additive: a v2 client
 * reads the fields it knows and ignores the rest.
 */
function encodePaymentSummary(payment: PaymentSummary): string {
  return encodeHeaderDocument({
    success: payment.status === 'settled',
    transaction: payment.externalReference ?? '',
    network: payment.network ?? '',
    status: payment.status,
    provider: payment.provider,
    amount: payment.amount,
    currency: payment.currency,
    ...(payment.externalReference !== undefined
      ? { externalReference: payment.externalReference }
      : {}),
  });
}

/** Undefined = no limit given / unparseable (caller applies its own default). A
 * parseable but non-positive value (SQLite treats a negative LIMIT as
 * unbounded) is a caller error, not silently "no limit". */
function parseLimit(value: unknown): number | undefined {
  if (Array.isArray(value)) return parseLimit(value[0]);
  let n: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) n = Math.trunc(value);
  else if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) n = Math.trunc(parsed);
  }
  if (n === undefined) return undefined;
  if (n <= 0) {
    throw new CommerceError(
      'INPUT_INVALID',
      `Query parameter "limit" must be a positive integer (got ${n})`,
      {
        details: { field: 'limit' },
      },
    );
  }
  return n;
}
