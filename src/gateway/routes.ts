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
import { mppProblem } from '../payments/mpp/problems';
import {
  settlementFailure,
  settlementResponse,
  settlementResponseFromDetails,
  x402ErrorCode,
} from '../payments/x402/transport';
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
  // Track the selected rail so errors use its payment headers
  let paymentMethod: PaymentMethodName | undefined;

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
    paymentMethod = resource.paymentMethods[0];
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
      reply.header(
        PAYMENT_RESPONSE_HEADER,
        encodeHeaderDocument(settlementResponse(outcome.payment)),
      );
      const receipt = outcome.payment.metadata?.['receipt'];
      if (outcome.payment.provider === 'mpp' && typeof receipt === 'string') {
        reply.header('payment-receipt', receipt);
      }
      // Payment headers identify this buyer's payment; MPP also requires
      // private caching for responses carrying `Payment-Receipt`
      reply.header('cache-control', 'private');
    }
    reply.status(outcome.backendStatus).send(outcome.body);
  } catch (error) {
    sendInvokeError(reply, toCommerceError(error), paymentMethod);
  }
}

// Codes whose MPP response body is a Problem Details document
const MPP_PROBLEM_CODES: ReadonlySet<string> = new Set([
  'PAYMENT_INVALID',
  'PAYMENT_REPLAYED',
  'PAYMENT_SETTLEMENT_FAILED',
  'PAYMENT_PROVIDER_UNAVAILABLE',
]);

function sendInvokeError(
  reply: FastifyReply,
  error: CommerceError,
  paymentMethod: PaymentMethodName | undefined,
): void {
  const details = error.details;
  // Report a settled payment even if backend delivery fails. MPP forbids a
  // `Payment-Receipt` header on error responses, so send only this summary
  const settled = settlementResponseFromDetails(details);
  if (settled !== undefined) {
    reply.header(PAYMENT_RESPONSE_HEADER, encodeHeaderDocument(settled));
  }
  if (error.code === 'PAYMENT_SETTLEMENT_FAILED') {
    reply.header(PAYMENT_RESPONSE_HEADER, encodeHeaderDocument(settlementFailure(details)));
  }
  // Attach a fresh challenge to a 402 when the rail provides one
  const challenge = details?.['challenge'];
  if (error.httpStatus === 402 && isRecord(challenge)) {
    if (paymentMethod === 'mpp' && typeof challenge['wwwAuthenticate'] === 'string') {
      reply.header('www-authenticate', challenge['wwwAuthenticate']);
    } else if (paymentMethod === 'x402' && error.code !== 'PAYMENT_SETTLEMENT_FAILED') {
      // x402 includes the reason in the challenge; settlement refusals use
      // `PAYMENT-RESPONSE` alone
      reply.header(
        PAYMENT_REQUIRED_HEADER,
        encodeHeaderDocument({
          ...challenge,
          error: x402ErrorCode(error.code, details?.['reason']),
        }),
      );
    }
    reply.header('cache-control', 'no-store');
  }

  const envelope = toErrorEnvelope(error);
  if (paymentMethod === 'mpp' && MPP_PROBLEM_CODES.has(error.code)) {
    // RFC 9457 `status` is the HTTP status, so it replaces the envelope's
    // `status: 'error'`; the other envelope fields stay as extension members
    const { status: _envelopeStatus, ...members } = envelope;
    const reason = typeof details?.['reason'] === 'string' ? details['reason'] : undefined;
    reply
      .header('content-type', 'application/problem+json')
      .status(error.httpStatus)
      .send({
        ...mppProblem(error.code, error.httpStatus, reason),
        status: error.httpStatus,
        detail: error.message,
        ...members,
      });
    return;
  }
  reply.status(error.httpStatus).send(envelope);
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

/**
 * Base64 of a JSON document, the encoding every x402 v2 payment header uses.
 * Not imported from the x402 SDK: this module is reachable from the main
 * entry point, which must import no optional peer.
 */
function encodeHeaderDocument(document: unknown): string {
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64');
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
