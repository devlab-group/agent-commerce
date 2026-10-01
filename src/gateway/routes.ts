/**
 * The gateway's own HTTP surface (docs/contracts.md "Gateway HTTP surface").
 * Adapter mounting (e.g. `/mcp`) is handled separately in adapters.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../config';
import {
  AUTHORIZATION_HEADER,
  type AuthorizationProvider,
  type CanonicalRequest,
  type Clock,
  CommerceError,
  type ExecutionPipeline,
  type Logger,
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type PaymentMethodName,
  type PaymentProvider,
  parseAuthorizationHeader,
  type ReceiptStore,
  type ResourceRegistry,
  toCommerceError,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from '../core';
import { isRecord } from '../core/is-record';
import { buildOperatorTokenHook } from './access-control';
import type { AdapterRuntime } from './adapters';
import { toPublicResource } from './public-resource';
import { createReadinessProbe } from './readiness';
import { buildWellKnownDocument } from './well-known';

export interface RegisterRoutesOptions {
  readonly server: FastifyInstance;
  readonly config: GatewayConfig;
  readonly pipeline: ExecutionPipeline;
  readonly resources: ResourceRegistry;
  readonly store: ReceiptStore;
  readonly paymentProviders: readonly PaymentProvider[];
  readonly authorizationProviders: readonly AuthorizationProvider[];
  readonly clock: Clock;
  readonly adapterRuntimes: readonly AdapterRuntime[];
  readonly logger: Logger;
}

export function registerRoutes(options: RegisterRoutesOptions): void {
  const { server } = options;

  // `adapterRuntimes` is filled in place once adapters start, so the probe
  // reads the live list
  const readinessProbe = createReadinessProbe({
    store: options.store,
    adapterRuntimes: options.adapterRuntimes,
    paymentProviders: options.paymentProviders,
    authorizationProviders: options.authorizationProviders,
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
      authorizationProviders: options.authorizationProviders,
      store: options.store,
      adapters: await readinessProbe.adapterHealth(),
    }),
  );

  server.get('/api/resources', async () => ({
    resources: options.resources.list().map(toPublicResource),
  }));

  server.post('/api/resources/:id/invoke', async (request, reply) => {
    await handleInvoke(request, reply, options);
  });

  // The admin token gate is per route, not global; access-control.ts says why
  const tokenHook = buildOperatorTokenHook(options.config.server.adminToken);

  server.get(
    '/api/receipts',
    { onRequest: tokenHook },
    ledgerHandler('receipts', (list) => options.store.listReceipts(list)),
  );
  server.get(
    '/api/events',
    { onRequest: tokenHook },
    ledgerHandler('events', (list) => options.store.listEvents(list)),
  );
}

// `GET /api/receipts` and `GET /api/events`: one page of a ledger
function ledgerHandler<K extends string>(
  key: K,
  list: (options: { limit?: number }) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<Record<K, unknown> | undefined> {
  return async (request, reply) => {
    try {
      const limit = parseLimit((request.query as Record<string, unknown>)['limit']);
      return { [key]: await list(limit !== undefined ? { limit } : {}) } as Record<K, unknown>;
    } catch (error) {
      const commerceError = toCommerceError(error);
      reply.status(commerceError.httpStatus).send(toErrorEnvelope(commerceError));
      return undefined;
    }
  };
}

async function handleInvoke(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RegisterRoutesOptions,
): Promise<void> {
  const resourceId = (request.params as { id: string }).id;

  try {
    const resource = options.resources.get(resourceId);
    if (!resource?.exposedVia.includes('http')) {
      throw new CommerceError('RESOURCE_NOT_FOUND', `Resource "${resourceId}" was not found`, {
        requestId: request.id,
        resourceId,
      });
    }

    // createGateway puts provider-backed methods first, so this label matches
    // the rail selected by the pipeline. Without a method, drop the proof
    // instead of inventing a rail; the pipeline receives an unpaid request.
    const paymentMethod = resource.paymentMethods[0];
    const paymentValue = paymentProof(request, paymentMethod);
    const payment =
      paymentValue !== undefined && paymentMethod !== undefined
        ? { method: paymentMethod, payload: paymentValue }
        : undefined;

    // Its own header rather than a reserved body field: HTTP already carries
    // the payment proof out of band, and an authorization inside the body
    // would have to survive every backend input-binding mode intact
    const authorization = parseAuthorizationHeader(
      request.headers[AUTHORIZATION_HEADER],
      request.id,
    );

    const canonicalRequest: CanonicalRequest = {
      requestId: request.id,
      resourceId,
      input: request.body ?? {},
      protocol: 'http',
      receivedAt: options.clock.nowIso(),
      ...(payment !== undefined ? { payment } : {}),
      ...(authorization !== undefined ? { authorization } : {}),
    };

    const outcome = await options.pipeline.execute(canonicalRequest);

    if (outcome.kind === 'payment-required') {
      const envelope = toPaymentRequiredEnvelope(outcome);
      if (envelope.payment.provider === 'mpp') {
        const challenge = envelope.payment.envelope?.['wwwAuthenticate'];
        if (typeof challenge === 'string') reply.header('www-authenticate', challenge);
      } else if (envelope.payment.envelope !== undefined) {
        // x402 v2 clients read the challenge from this header and ignore the
        // body, which still carries the full envelope
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
      const receipt = outcome.payment.metadata?.['receipt'];
      if (outcome.payment.provider === 'mpp' && typeof receipt === 'string') {
        reply.header('payment-receipt', receipt);
      }
    }
    reply.status(outcome.backendStatus).send(outcome.body);
  } catch (error) {
    const commerceError = toCommerceError(error);
    // A backend failure after settlement carries the payment summary in
    // details.payment. Send the success path's headers so the buyer still
    // learns what they paid.
    const settledPayment = errorPaymentSummary(commerceError);
    if (settledPayment !== undefined) {
      reply.header(PAYMENT_RESPONSE_HEADER, encodePaymentSummary(settledPayment));
      if (settledPayment.provider === 'mpp' && settledPayment.receipt !== undefined) {
        reply.header('payment-receipt', settledPayment.receipt);
      }
    }
    // An MPP client pays again only from a fresh WWW-Authenticate challenge
    const challenge = commerceError.details?.['challenge'] as Record<string, unknown> | undefined;
    if (
      commerceError.code === 'PAYMENT_INVALID' &&
      typeof challenge?.['wwwAuthenticate'] === 'string'
    ) {
      reply.header('www-authenticate', challenge['wwwAuthenticate']);
      reply.header('cache-control', 'no-store');
    }
    reply.status(commerceError.httpStatus).send(toErrorEnvelope(commerceError));
  }
}

// Each rail has its own proof header. MPP uses HTTP authentication, and an
// `Authorization` value in another scheme is not a payment proof.
function paymentProof(
  request: FastifyRequest,
  method: PaymentMethodName | undefined,
): string | undefined {
  if (method === 'mpp') {
    const value = request.headers.authorization;
    return value !== undefined && /^Payment\s+\S/i.test(value) ? value : undefined;
  }
  const value = request.headers[PAYMENT_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

interface PaymentSummary {
  readonly status: string;
  readonly provider: string;
  readonly amount: string;
  readonly currency: string;
  readonly network?: string;
  readonly externalReference?: string;
  // Serialized MPP `Payment-Receipt`, when the provider issued one
  readonly receipt?: string;
}

function errorPaymentSummary(
  error: ReturnType<typeof toCommerceError>,
): PaymentSummary | undefined {
  const payment = error.details?.['payment'];
  if (!isRecord(payment)) return undefined;
  const { status, provider, amount, currency, network, externalReference, receipt } = payment;
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
    ...(typeof receipt === 'string' ? { receipt } : {}),
  };
}

/**
 * Base64 of a JSON document, the encoding every x402 v2 payment header uses.
 * Not imported from the x402 SDK: this module is reachable from the main
 * entry point, which must import no optional peer.
 */
function encodeHeaderDocument(document: unknown): string {
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64');
}

/**
 * The settlement result in the `SettleResponse` shape an x402 v2 client
 * decodes from `PAYMENT-RESPONSE`. `status`, `provider`, `amount`, `currency`
 * and `externalReference` are ours; a v2 client ignores fields it does not know.
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

// Undefined when absent or unparseable, so the store applies its default. A
// parseable value below 1 is INPUT_INVALID, because SQLite reads a negative
// LIMIT as unbounded.
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
