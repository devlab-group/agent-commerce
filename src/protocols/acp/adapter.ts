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
  type HttpProtocolAdapter,
  type ProtocolAdapterContext,
  toCommerceError,
} from '../../core/index.js';
import { PACKAGE_VERSION } from '../../version.js';
import {
  ACP_IDEMPOTENCY_KEY_HEADER,
  ACP_IDEMPOTENT_REPLAYED_HEADER,
  ACP_IN_FLIGHT_RETRY_AFTER_SECONDS,
  ACP_REQUEST_ID_HEADER,
  ACP_WELL_KNOWN_PATH,
} from './constants.js';
import { buildDescriptor } from './descriptor.js';
import { type AcpDiscoveryMetadata, buildAcpDiscoveryDocument } from './discovery.js';
import { type AcpFailure, acpFailure, writeAcpFailure, writeAcpJson } from './errors.js';
import { identityHash, requestFingerprint } from './idempotency/fingerprint.js';
import {
  type AcpIdempotencyScope,
  type AcpIdempotencyStore,
  createAcpIdempotencyStore,
} from './idempotency/store.js';
import { type AcpGuardedRequest, guardAcpRequest } from './request-guards.js';
import { validateAcpDocument } from './validation.js';

/** Discovery is stable for the life of the process, so it is safe to cache at the edge. */
const DISCOVERY_CACHE_CONTROL = 'public, max-age=3600';

export interface AcpAdapterOptions {
  readonly mountPath: string;
  /** The configured bearer token. Never logged, never echoed, never published. */
  readonly token: string;
  /** Where checkout idempotency records live, and how long they are kept. */
  readonly idempotency: { readonly path: string; readonly retentionHours: number };
  readonly discovery?: AcpDiscoveryMetadata;
}

/** One ACP answer, as a value: it may have to be stored before it is written. */
interface AcpResponse {
  readonly status: number;
  readonly body: unknown;
  /** True when this answer came from the idempotency store rather than from work done now. */
  readonly replayed?: boolean;
}

export class AcpProtocolAdapter implements HttpProtocolAdapter {
  readonly name = 'acp' as const;
  readonly mountPath: string;
  readonly descriptor: AdapterDescriptor;
  readonly additionalHttpRoutes: readonly AdapterHttpRoute[];

  private readonly token: string;
  private readonly idempotencyOptions: AcpAdapterOptions['idempotency'];
  /** Derived once: the token is fixed, and only its digest may be persisted. */
  private readonly identityHash: string;
  private readonly discoveryMetadata: AcpDiscoveryMetadata | undefined;
  private idempotency: AcpIdempotencyStore | undefined;

  private context: ProtocolAdapterContext | undefined;
  private started = false;
  // Built once at start: the document is fixed by config, and rebuilding it
  // per request would let an unauthenticated GET do work a caller controls the
  // cost of.
  private discovery: Record<string, unknown> | undefined;

  constructor(options: AcpAdapterOptions) {
    this.mountPath = options.mountPath;
    this.token = options.token;
    this.idempotencyOptions = options.idempotency;
    this.identityHash = identityHash(options.token);
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
    const key = request.idempotencyKey;
    if (store === undefined || key === undefined) return this.runCheckout(request);

    const scope: AcpIdempotencyScope = {
      identityHash: this.identityHash,
      endpoint: request.route.path,
      key,
    };
    const claim = store.claim(scope, requestFingerprint(request.body));

    switch (claim.kind) {
      case 'in-flight':
        return this.asResponse(
          acpFailure(
            409,
            'invalid_request',
            'idempotency_in_flight',
            'A request with this Idempotency-Key is still being processed.',
          ),
        );
      case 'conflict':
        return this.asResponse(
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

    let response: AcpResponse;
    try {
      response = await this.runCheckout(request);
    } catch (err) {
      // The attempt produced no answer worth keeping, so the key is freed for a
      // clean retry rather than left claimed by a request that never completed.
      store.release(scope);
      throw err;
    }

    // 5xx is never cached: a transient failure must not poison the key for the
    // whole retention window. 2xx and 4xx are the answer to this request and
    // every retry of it.
    if (response.status >= 500) store.release(scope);
    else store.complete(scope, response);
    return response;
  }

  /**
   * Everything above this line has held. Execution is not wired yet, and the
   * answer says so instead of inventing a checkout session.
   */
  private async runCheckout(request: AcpGuardedRequest): Promise<AcpResponse> {
    return this.asResponse(
      acpFailure(
        501,
        'processing_error',
        'not_implemented',
        `ACP operation "${request.route.operation}" is not available in this build.`,
      ),
    );
  }

  private asResponse(failure: AcpFailure): AcpResponse {
    return { status: failure.status, body: failure.error };
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
      ...(response?.status === 409
        ? { 'retry-after': String(ACP_IN_FLIGHT_RETRY_AFTER_SECONDS) }
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
    this.idempotency?.close();
    this.idempotency = undefined;
    this.context = undefined;
  }
}

export function createAcpAdapter(options: AcpAdapterOptions): AcpProtocolAdapter {
  return new AcpProtocolAdapter(options);
}
