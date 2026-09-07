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
import { ACP_REQUEST_ID_HEADER, ACP_WELL_KNOWN_PATH } from './constants.js';
import { buildDescriptor } from './descriptor.js';
import { type AcpDiscoveryMetadata, buildAcpDiscoveryDocument } from './discovery.js';
import { acpFailure, writeAcpFailure, writeAcpJson } from './errors.js';
import { type AcpGuardedRequest, guardAcpRequest } from './request-guards.js';
import { validateAcpDocument } from './validation.js';

/** Discovery is stable for the life of the process, so it is safe to cache at the edge. */
const DISCOVERY_CACHE_CONTROL = 'public, max-age=3600';

export interface AcpAdapterOptions {
  readonly mountPath: string;
  /** The configured bearer token. Never logged, never echoed, never published. */
  readonly token: string;
  readonly discovery?: AcpDiscoveryMetadata;
}

export class AcpProtocolAdapter implements HttpProtocolAdapter {
  readonly name = 'acp' as const;
  readonly mountPath: string;
  readonly descriptor: AdapterDescriptor;
  readonly additionalHttpRoutes: readonly AdapterHttpRoute[];

  private readonly token: string;
  private readonly discoveryMetadata: AcpDiscoveryMetadata | undefined;

  private context: ProtocolAdapterContext | undefined;
  private started = false;
  // Built once at start: the document is fixed by config, and rebuilding it
  // per request would let an unauthenticated GET do work a caller controls the
  // cost of.
  private discovery: Record<string, unknown> | undefined;

  constructor(options: AcpAdapterOptions) {
    this.mountPath = options.mountPath;
    this.token = options.token;
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

    this.discovery = document;
    this.started = true;
    context.logger.info(
      { mountPath: this.mountPath, discoveryPath: ACP_WELL_KNOWN_PATH },
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

      await this.handleCheckout(guarded.value, res);
    } catch (err) {
      this.fail(res, err, 'acp adapter: request handling failed');
    }
  }

  /**
   * Everything above this line has held. Execution is not wired yet, and the
   * answer says so instead of inventing a checkout session.
   */
  private async handleCheckout(request: AcpGuardedRequest, res: ServerResponse): Promise<void> {
    writeAcpFailure(
      res,
      acpFailure(
        501,
        'processing_error',
        'not_implemented',
        `ACP operation "${request.route.operation}" is not available in this build.`,
      ),
      this.responseHeaders(request),
    );
  }

  /**
   * Protocol-owned headers only. A merchant backend's own headers are never
   * proxied onto an ACP response.
   */
  private responseHeaders(request: AcpGuardedRequest): Readonly<Record<string, string>> {
    return request.requestId !== undefined ? { [ACP_REQUEST_ID_HEADER]: request.requestId } : {};
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
    this.context = undefined;
  }
}

export function createAcpAdapter(options: AcpAdapterOptions): AcpProtocolAdapter {
  return new AcpProtocolAdapter(options);
}
