/**
 * ACP (Agentic Commerce Protocol) adapter - experimental.
 *
 * Serves two paths: the configured mount (`/acp`), where the five stable
 * checkout routes live, and the specification-fixed `/.well-known/acp.json`,
 * declared through `additionalHttpRoutes` so the gateway needs no ACP-specific
 * routing.
 *
 * Discovery and every protocol guard that must hold before canonical execution
 * are implemented. A guarded request is not executed yet: until checkout
 * operations reach the pipeline, a fully-valid request is answered with an
 * honest "not implemented" rather than a fabricated session.
 *
 * This file never calls a merchant backend and never inspects a payment
 * object.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type AdapterHttpRoute,
  CommerceError,
  type CommerceResource,
  type DeliveredOutcome,
  type HttpProtocolAdapter,
  type ProtocolAdapterContext,
  toCommerceError,
} from '../../core/index.js';
import { PACKAGE_VERSION } from '../../version.js';
import { toCanonicalRequest } from './checkout-mapping.js';
import {
  ACP_CHECKOUT_OPERATIONS,
  ACP_IDEMPOTENCY_KEY_HEADER,
  ACP_IDEMPOTENT_REPLAYED_HEADER,
  ACP_IN_FLIGHT_RETRY_AFTER_SECONDS,
  ACP_REQUEST_ID_HEADER,
  ACP_WELL_KNOWN_PATH,
  type AcpCheckoutOperation,
} from './constants.js';
import { buildDescriptor } from './descriptor.js';
import { type AcpDiscoveryMetadata, buildAcpDiscoveryDocument } from './discovery.js';
import { type AcpFailure, acpFailure, writeAcpFailure, writeAcpJson } from './errors.js';
import { operationKey, requestFingerprint } from './idempotency/fingerprint.js';
import {
  type AcpIdempotencyScope,
  type AcpIdempotencyStore,
  createAcpIdempotencyStore,
} from './idempotency/store.js';
import { type AcpGuardedRequest, guardAcpRequest } from './request-guards.js';
import {
  type AcpResponse,
  asResponse,
  mapCommerceErrorToAcp,
  toAcpResponse,
} from './response-mapping.js';
import { validateAcpDocument } from './validation.js';

/** Discovery is stable for the life of the process, so it is safe to cache at the edge. */
const DISCOVERY_CACHE_CONTROL = 'public, max-age=3600';

/**
 * Whether this attempt could have changed anything at the merchant.
 *
 * `no` has to be a proof, never a guess: it is the only value that frees an
 * idempotency key for a retry. The caller treats `unknown` and `yes` alike,
 * and they are kept apart only so a log says which it was.
 */
type MerchantReach = 'no' | 'unknown' | 'yes';

interface AcpCheckoutAttempt {
  readonly response: AcpResponse;
  readonly reached: MerchantReach;
}

/**
 * The codes the pipeline raises strictly before it calls the merchant.
 *
 * An allowlist, so a code added later is ambiguous by default rather than
 * silently freeing a key. `STORAGE_ERROR` is deliberately absent: the receipt
 * is written *after* delivery, so it means the merchant did act.
 */
const PRE_BACKEND_ERROR_CODES: ReadonlySet<string> = new Set([
  'CONFIG_INVALID',
  'RESOURCE_NOT_FOUND',
  'INPUT_INVALID',
  'PROTOCOL_UNSUPPORTED',
  'GATEWAY_BUSY',
  'PAYMENT_REQUIRED',
  'PAYMENT_INVALID',
  'PAYMENT_REPLAYED',
  'PAYMENT_PROVIDER_UNAVAILABLE',
  'PAYMENT_SETTLEMENT_FAILED',
  'AUTHORIZATION_REQUIRED',
  'AUTHORIZATION_INVALID',
  'AUTHORIZATION_REPLAYED',
  'AUTHORIZATION_PROVIDER_UNAVAILABLE',
]);

function reachedFor(code: string): MerchantReach {
  return PRE_BACKEND_ERROR_CODES.has(code) ? 'no' : 'unknown';
}

function notReached(failure: AcpFailure): AcpCheckoutAttempt {
  return { response: asResponse(failure), reached: 'no' };
}

export interface AcpAdapterOptions {
  readonly mountPath: string;
  /** The configured bearer token. Never logged, never echoed, never published. */
  readonly token: string;
  /** Which canonical resource implements each ACP checkout operation. */
  readonly operations: Readonly<Record<AcpCheckoutOperation, string>>;
  /** Where checkout idempotency records live, and how long they are kept. */
  readonly idempotency: { readonly path: string; readonly retentionHours: number };
  readonly discovery?: AcpDiscoveryMetadata;
}

export class AcpProtocolAdapter implements HttpProtocolAdapter {
  readonly name = 'acp' as const;
  readonly mountPath: string;
  readonly descriptor: AdapterDescriptor;
  readonly additionalHttpRoutes: readonly AdapterHttpRoute[];

  private readonly token: string;
  private readonly operations: Readonly<Record<AcpCheckoutOperation, string>>;
  private readonly idempotencyOptions: AcpAdapterOptions['idempotency'];
  /**
   * What an idempotency claim is scoped to, from `context.publicBaseUrl`.
   *
   * Not readonly because, unlike the token, it is known only once the adapter
   * starts. Worth that: scoping by the credential meant a rotation freed
   * every outstanding claim.
   */
  private deployment: string | undefined;
  private readonly discoveryMetadata: AcpDiscoveryMetadata | undefined;
  private idempotency: AcpIdempotencyStore | undefined;
  private resources: ReadonlyMap<AcpCheckoutOperation, CommerceResource> = new Map();

  private context: ProtocolAdapterContext | undefined;
  private started = false;
  // Built once at start: the document is fixed by config, and rebuilding it
  // per request would let an unauthenticated GET do work a caller controls the
  // cost of.
  private discovery: Record<string, unknown> | undefined;

  constructor(options: AcpAdapterOptions) {
    this.mountPath = options.mountPath;
    this.token = options.token;
    this.operations = options.operations;
    this.idempotencyOptions = options.idempotency;
    this.discoveryMetadata = options.discovery;
    this.descriptor = buildDescriptor(PACKAGE_VERSION);
    this.additionalHttpRoutes = [
      {
        method: 'GET',
        path: ACP_WELL_KNOWN_PATH,
        handleHttp: (req, res) => this.handleDiscovery(req, res),
      },
    ];
  }

  async start(context: ProtocolAdapterContext): Promise<void> {
    this.context = context;
    this.started = false;

    const document = buildAcpDiscoveryDocument({
      publicBaseUrl: context.publicBaseUrl,
      mountPath: this.mountPath,
      ...(this.discoveryMetadata !== undefined ? { metadata: this.discoveryMetadata } : {}),
    });
    // Validated against the pinned snapshot rather than trusted: configured
    // metadata is free text (a currency that is not ISO 4217, an intervention
    // type ACP does not define), and publishing a document that fails ACP's own
    // schema would be the blanket-compatibility claim this project refuses to
    // make. Failing here fails only this adapter - the gateway isolates it.
    const invalid = validateAcpDocument('discoveryResponse', document);
    if (invalid !== undefined) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `ACP discovery document does not conform to the ${this.descriptor.supportedSpec} snapshot at "${invalid.path ?? '$'}" (${invalid.code}) - check protocols.acp.discovery`,
        { details: { path: invalid.path ?? '$', code: invalid.code } },
      );
    }

    // The same defence in depth MCP and A2A apply: config already refuses a
    // mapping to a resource that is not acp-exposed, but the adapter must not
    // rely on that alone to keep a resource scoped to another protocol out of
    // an ACP checkout.
    const exposed = new Map(
      context.resources.listExposedVia('acp').map((resource) => [resource.id, resource]),
    );
    const resolved = new Map<AcpCheckoutOperation, CommerceResource>();
    for (const operation of ACP_CHECKOUT_OPERATIONS) {
      const resourceId = this.operations[operation];
      const resource = exposed.get(resourceId);
      if (resource === undefined) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `ACP operation "${operation}" is mapped to resource "${resourceId}", which is not exposed via acp`,
          { details: { operation, resourceId } },
        );
      }
      resolved.set(operation, resource);
    }
    this.resources = resolved;

    this.deployment = context.publicBaseUrl;
    this.idempotency = createAcpIdempotencyStore({
      path: this.idempotencyOptions.path,
      retentionHours: this.idempotencyOptions.retentionHours,
      logger: context.logger,
    });

    this.discovery = document;
    this.started = true;
    context.logger.info(
      {
        mountPath: this.mountPath,
        discoveryPath: ACP_WELL_KNOWN_PATH,
        idempotencyRetentionHours: this.idempotencyOptions.retentionHours,
      },
      'acp adapter started',
    );
  }

  /** `GET /.well-known/acp.json` - public, unauthenticated, cacheable. */
  async handleDiscovery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.started || this.discovery === undefined) {
        writeAcpFailure(
          res,
          acpFailure(
            503,
            'service_unavailable',
            'service_unavailable',
            'The ACP adapter is not running.',
          ),
        );
        return;
      }
      if (req.method !== 'GET') {
        writeAcpFailure(
          res,
          acpFailure(
            405,
            'invalid_request',
            'method_not_allowed',
            'The ACP discovery document is read-only.',
          ),
        );
        return;
      }
      writeAcpJson(res, 200, this.discovery, { 'cache-control': DISCOVERY_CACHE_CONTROL });
    } catch (err) {
      this.fail(res, err, 'acp adapter: discovery request failed');
    }
  }

  /** `<mountPath>/checkout_sessions...` - the five stable checkout routes. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.started) {
        writeAcpFailure(
          res,
          acpFailure(
            503,
            'service_unavailable',
            'service_unavailable',
            'The ACP adapter is not running.',
          ),
        );
        return;
      }

      const guarded = await guardAcpRequest(req, {
        mountPath: this.mountPath,
        token: this.token,
      });
      if (!guarded.ok) {
        // A guard failure never carries a Request-Id echo: the header is only
        // normalised once the request is known to be well-formed.
        writeAcpFailure(res, guarded);
        return;
      }

      const request = guarded.value;
      const response = await this.dispatch(request);
      writeAcpJson(res, response.status, response.body, this.responseHeaders(request, response));
    } catch (err) {
      this.fail(res, err, 'acp adapter: request handling failed');
    }
  }

  /**
   * One request, at most one execution.
   *
   * A body-bearing route claims its idempotency key *before* the work starts,
   * so a retry that arrives while the first one is still running finds the
   * claim instead of starting a second checkout. A route with no key (the GET)
   * is read-only and needs none.
   */
  private async dispatch(request: AcpGuardedRequest): Promise<AcpResponse> {
    const store = this.idempotency;
    const deployment = this.deployment;
    const key = request.idempotencyKey;
    if (store === undefined || deployment === undefined || key === undefined) {
      return (await this.runCheckout(request)).response;
    }

    const scope: AcpIdempotencyScope = { deployment, endpoint: request.route.path, key };
    const claim = store.claim(scope, requestFingerprint(request.body));

    switch (claim.kind) {
      case 'in-flight':
        return {
          ...asResponse(
            acpFailure(
              409,
              'invalid_request',
              'idempotency_in_flight',
              'A request with this Idempotency-Key is still being processed.',
            ),
          ),
          retryAfterSeconds: ACP_IN_FLIGHT_RETRY_AFTER_SECONDS,
        };
      case 'unresolved':
        // Not "try again": an earlier attempt reached the merchant and nobody
        // learned its outcome. Re-running it could order twice, and replaying
        // it would invent an answer nobody gave. It may already have
        // succeeded, and only the merchant's records can say.
        return asResponse(
          acpFailure(
            409,
            'processing_error',
            'idempotency_unresolved',
            'An earlier request with this Idempotency-Key reached the merchant and its outcome is unknown. Check the operation with the merchant before retrying.',
          ),
        );
      case 'conflict':
        return asResponse(
          acpFailure(
            422,
            'invalid_request',
            'idempotency_conflict',
            'This Idempotency-Key was already used for a different request body.',
          ),
        );
      case 'replay':
        return { status: claim.status, body: claim.body, replayed: true };
      default:
        break;
    }

    let outcome: AcpCheckoutAttempt;
    try {
      outcome = await this.runCheckout(request, operationKey(scope));
    } catch (err) {
      // A throw here is a bug in this adapter, not a merchant verdict, and it
      // says nothing about how far the request had got. The merchant may have
      // been called, so the claim is kept.
      store.markUnresolved(scope);
      throw err;
    }

    // A 2xx or 4xx is the answer to this request and every retry of it: the
    // merchant stated an outcome, even a refusing one, so it is cached.
    if (outcome.response.status < 500) {
      store.complete(scope, outcome.response);
    } else if (outcome.reached === 'no') {
      // Proven never to have left the gateway, so the key is freed and the
      // caller can retry cleanly once the deployment is fixed.
      store.release(scope);
    } else {
      // A timeout, a merchant 5xx, or a reply we could not read. None of them
      // say the merchant did nothing, and freeing the key here is how one
      // checkout becomes two orders.
      store.markUnresolved(scope);
    }
    return outcome.response;
  }

  /**
   * One accepted request, one `pipeline.execute()`.
   *
   * Nothing here prices a resource, inspects a payment proof or calls a
   * merchant backend: the adapter builds a canonical request and reads back
   * what the pipeline decided.
   */
  private async runCheckout(
    request: AcpGuardedRequest,
    idempotencyKey?: string,
  ): Promise<AcpCheckoutAttempt> {
    const context = this.context;
    const resource = this.resources.get(request.route.operation);
    if (context === undefined || resource === undefined) {
      return notReached(
        acpFailure(
          503,
          'service_unavailable',
          'service_unavailable',
          'The ACP adapter is not running.',
        ),
      );
    }

    const canonical = toCanonicalRequest({
      request,
      resourceId: resource.id,
      requestId: context.ids.next('acp'),
      receivedAt: context.clock.nowIso(),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });

    try {
      const outcome = await context.pipeline.execute(canonical);
      if (outcome.kind === 'payment-required') {
        // ACP has no wire representation for a gateway payment challenge, and
        // config refuses a paid checkout resource - so reaching this is a
        // broken deployment, not something the caller can act on. Nothing about
        // the challenge is disclosed.
        context.logger.error(
          { resourceId: resource.id, requestId: canonical.requestId },
          'acp adapter: mapped checkout resource returned payment-required - it must be priced free',
        );
        return notReached(
          acpFailure(
            500,
            'processing_error',
            'processing_error',
            'The server could not process this checkout operation.',
          ),
        );
      }
      const mapped = toAcpResponse(request.route.operation, outcome as DeliveredOutcome);
      if (mapped.logDetail !== undefined) {
        // The merchant answered, but not with ACP. Everything needed to fix it
        // goes to the log; the caller gets the safe refusal in `response`.
        context.logger.error(
          { resourceId: resource.id, requestId: canonical.requestId, ...mapped.logDetail },
          'acp adapter: refusing to forward a non-conformant merchant response',
        );
      }
      // The pipeline delivered, so the merchant ran the operation - including
      // where its answer was not ACP and is being refused. The order may well
      // exist, and the key must not be freed for a retry.
      return { response: mapped.response, reached: 'yes' };
    } catch (err) {
      const error = toCommerceError(err);
      context.logger.warn(
        {
          resourceId: resource.id,
          requestId: canonical.requestId,
          reached: reachedFor(error.code),
          err: error.toInfo(),
        },
        'acp adapter: checkout execution failed',
      );
      return {
        response: asResponse(mapCommerceErrorToAcp(error, request.route.operation)),
        reached: reachedFor(error.code),
      };
    }
  }

  /**
   * Protocol-owned headers only. A merchant backend's own headers are never
   * proxied onto an ACP response.
   */
  private responseHeaders(
    request: AcpGuardedRequest,
    response?: AcpResponse,
  ): Readonly<Record<string, string>> {
    const replayed = response?.replayed === true;
    return {
      ...(request.requestId !== undefined ? { [ACP_REQUEST_ID_HEADER]: request.requestId } : {}),
      ...(request.idempotencyKey !== undefined
        ? { [ACP_IDEMPOTENCY_KEY_HEADER]: request.idempotencyKey }
        : {}),
      ...(replayed ? { [ACP_IDEMPOTENT_REPLAYED_HEADER]: 'true' } : {}),
      ...(response?.retryAfterSeconds !== undefined
        ? { 'retry-after': String(response.retryAfterSeconds) }
        : {}),
    };
  }

  private fail(res: ServerResponse, err: unknown, message: string): void {
    // Nothing from `err` reaches the client: stack, exception name and any
    // upstream detail stay in the log.
    this.context?.logger.error({ err: toCommerceError(err).toInfo() }, message);
    writeAcpFailure(
      res,
      acpFailure(500, 'processing_error', 'internal_error', 'Internal server error.'),
    );
  }

  async health(): Promise<AdapterHealth> {
    const checkedAt = this.context?.clock.nowIso() ?? new Date().toISOString();
    if (!this.started || this.discovery === undefined) {
      return { status: 'fail', detail: 'ACP adapter has not been started.', checkedAt };
    }
    return {
      status: 'pass',
      detail: `checkout service published at ${this.mountPath}.`,
      checkedAt,
    };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.discovery = undefined;
    this.resources = new Map();
    this.idempotency?.close();
    this.idempotency = undefined;
    this.deployment = undefined;
    this.context = undefined;
  }
}

export function createAcpAdapter(options: AcpAdapterOptions): AcpProtocolAdapter {
  return new AcpProtocolAdapter(options);
}
