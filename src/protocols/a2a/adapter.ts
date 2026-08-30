/**
 * A2A (Agent2Agent) protocol adapter — experimental.
 *
 * Serves two paths: the configured mount (`/a2a`), where the JSON-RPC endpoint
 * lives, and the specification-fixed `/.well-known/agent-card.json`, declared
 * through `additionalHttpRoutes` so the gateway needs no A2A-specific routing.
 *
 * Only the synchronous `SendMessage` path is in scope; every other A2A method
 * is listed in `descriptor.unsupported` rather than half-served. This file
 * never calls a merchant backend and never inspects a payment object.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type AdapterHttpRoute,
  type CanonicalRequest,
  CommerceError,
  type CommerceErrorCode,
  type CommerceResource,
  type ExecutionOutcome,
  type HttpProtocolAdapter,
  type ProtocolAdapterContext,
  toCommerceError,
  toDeliverySummary,
  toPaymentRequiredEnvelope,
} from '../../core/index.js';
import { PACKAGE_VERSION } from '../../version.js';
import { buildAgentCard } from './agent-card.js';
import {
  A2A_AGENT_CARD_PATH,
  A2A_DEFAULT_AGENT_NAME,
  A2A_DEFAULT_MOUNT_PATH,
  A2A_JSON_MEDIA_TYPE,
  A2A_METHOD_SEND_MESSAGE,
  A2A_PROTOCOL_VERSION,
  A2A_UNSUPPORTED_METHODS,
  A2A_VERSION_HEADER,
} from './constants.js';
import { buildDescriptor } from './descriptor.js';
import {
  A2A_ERROR_UNSUPPORTED_OPERATION,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type JsonRpcId,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpcRequest,
} from './jsonrpc.js';
import {
  type A2aInvocation,
  extractPaymentSubmission,
  parseInvocation,
} from './message-mapping.js';
import type { A2aAgentCard } from './types.js';

/**
 * The gateway mount already destroys a connection whose body passes its cap,
 * so this is a second line rather than the only one — it bounds what this
 * adapter buffers if it is ever mounted somewhere without that guard.
 */
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export interface A2aAdapterOptions {
  readonly mountPath?: string;
  /** Agent name published on the card. */
  readonly agentName?: string;
  readonly agentDescription?: string;
  /** Version published on the card. Defaults to this package's version. */
  readonly agentVersion?: string;
}

const DEFAULT_AGENT_DESCRIPTION =
  'Agent Commerce Gateway — canonical commerce resources exposed as A2A skills.';

export class A2aProtocolAdapter implements HttpProtocolAdapter {
  readonly name = 'a2a' as const;
  readonly mountPath: string;
  readonly descriptor: AdapterDescriptor;
  readonly additionalHttpRoutes: readonly AdapterHttpRoute[];

  private readonly agentName: string;
  private readonly agentDescription: string;
  private readonly agentVersion: string;

  private context: ProtocolAdapterContext | undefined;
  private started = false;
  private skills: readonly CommerceResource[] = [];
  // Same defence in depth MCP applies: the card only advertises a2a-exposed
  // resources, but nothing stops a caller naming any id, and the adapter must
  // not rely on the pipeline alone to refuse one scoped to another protocol.
  private skillsById: ReadonlyMap<string, CommerceResource> = new Map();
  // Built once at start: resources are fixed at config load, and a card
  // rebuilt per request would let a discovery GET do work a caller controls
  // the cost of.
  private card: A2aAgentCard | undefined;

  constructor(options: A2aAdapterOptions = {}) {
    this.mountPath = options.mountPath ?? A2A_DEFAULT_MOUNT_PATH;
    this.agentName = options.agentName ?? A2A_DEFAULT_AGENT_NAME;
    this.agentDescription = options.agentDescription ?? DEFAULT_AGENT_DESCRIPTION;
    this.agentVersion = options.agentVersion ?? PACKAGE_VERSION;
    this.descriptor = buildDescriptor(PACKAGE_VERSION);
    this.additionalHttpRoutes = [
      {
        method: 'GET',
        path: A2A_AGENT_CARD_PATH,
        handleHttp: (req, res) => this.handleAgentCard(req, res),
      },
    ];
  }

  async start(context: ProtocolAdapterContext): Promise<void> {
    this.context = context;
    this.started = false;

    let resources: readonly CommerceResource[] = [];
    try {
      resources = context.resources.listExposedVia('a2a');
    } catch (err) {
      context.logger.error(
        { err: toCommerceError(err).toInfo() },
        'a2a adapter: failed to list a2a-exposed resources',
      );
      resources = [];
    }

    this.skills = resources;
    this.skillsById = new Map(resources.map((resource) => [resource.id, resource]));
    this.card = buildAgentCard({
      name: this.agentName,
      description: this.agentDescription,
      version: this.agentVersion,
      publicBaseUrl: context.publicBaseUrl,
      mountPath: this.mountPath,
      resources,
    });
    this.started = true;

    context.logger.info(
      { mountPath: this.mountPath, cardPath: A2A_AGENT_CARD_PATH, skillCount: resources.length },
      'a2a adapter started',
    );
  }

  /** `GET /.well-known/agent-card.json`. */
  async handleAgentCard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.started || this.card === undefined) {
        this.writeJson(res, 503, { error: 'A2A adapter is not running.' });
        return;
      }
      if (req.method !== 'GET') {
        this.writeJson(res, 405, { error: 'Method not allowed. The Agent Card is read-only.' });
        return;
      }
      this.writeJson(res, 200, this.card);
    } catch (err) {
      this.context?.logger.error(
        { err: toCommerceError(err).toInfo() },
        'a2a adapter: agent card request failed',
      );
      this.writeJson(res, 500, { error: 'Internal server error.' });
    }
  }

  /** `POST <mountPath>` — the A2A JSON-RPC endpoint. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.started) {
        this.writeJson(
          res,
          503,
          jsonRpcError(null, JSONRPC_INTERNAL_ERROR, 'A2A adapter is not running.'),
        );
        return;
      }
      if (req.method !== 'POST') {
        this.writeJson(
          res,
          405,
          jsonRpcError(
            null,
            JSONRPC_INVALID_REQUEST,
            'Method not allowed. This endpoint only accepts POST.',
          ),
        );
        return;
      }

      const version = req.headers[A2A_VERSION_HEADER];
      const declared = Array.isArray(version) ? version[0] : version;
      if (declared !== A2A_PROTOCOL_VERSION) {
        // Missing counts as unsupported: a client that negotiates no version
        // is speaking an older convention, and answering it as if it were v1
        // would be guessing on its behalf.
        this.writeJson(
          res,
          200,
          jsonRpcError(
            null,
            A2A_ERROR_UNSUPPORTED_OPERATION,
            `Unsupported A2A protocol version. Send the ${A2A_VERSION_HEADER} header with "${A2A_PROTOCOL_VERSION}".`,
          ),
        );
        return;
      }

      let body: string;
      try {
        body = await readBody(req, MAX_REQUEST_BODY_BYTES);
      } catch {
        this.writeJson(
          res,
          200,
          jsonRpcError(null, JSONRPC_PARSE_ERROR, 'Could not read the request body.'),
        );
        return;
      }

      const parsed = parseJsonRpcRequest(body);
      if (!parsed.ok) {
        this.writeJson(res, 200, jsonRpcError(parsed.id, parsed.error.code, parsed.error.message));
        return;
      }
      this.writeJson(
        res,
        200,
        await this.dispatch(parsed.request.id, parsed.request.method, parsed.request.params),
      );
    } catch (err) {
      // Nothing from `err` reaches the client: stack, exception name and any
      // upstream detail stay in the log.
      this.context?.logger.error(
        { err: toCommerceError(err).toInfo() },
        'a2a adapter: request handling failed',
      );
      this.writeJson(
        res,
        200,
        jsonRpcError(null, JSONRPC_INTERNAL_ERROR, 'Internal server error.'),
      );
    }
  }

  private async dispatch(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    if (A2A_UNSUPPORTED_METHODS.includes(method)) {
      return jsonRpcError(
        id,
        A2A_ERROR_UNSUPPORTED_OPERATION,
        `A2A method "${method}" is not supported by this deployment.`,
      );
    }
    if (method !== A2A_METHOD_SEND_MESSAGE) {
      return jsonRpcError(id, JSONRPC_METHOD_NOT_FOUND, `Unknown method "${method}".`);
    }

    let invocation: ReturnType<typeof parseInvocation>;
    try {
      invocation = parseInvocation(params);
    } catch (err) {
      const error = toCommerceError(err);
      const code =
        error.code === 'PROTOCOL_UNSUPPORTED'
          ? A2A_ERROR_UNSUPPORTED_OPERATION
          : JSONRPC_INVALID_PARAMS;
      // CommerceError messages are written for a client; nothing else is
      // relayed.
      return jsonRpcError(id, code, error.message);
    }

    return this.execute(id, invocation);
  }

  /**
   * One accepted invocation, one `pipeline.execute()`. Nothing here prices a
   * resource, inspects a proof or talks to a merchant backend — the adapter
   * builds a `CanonicalRequest` and reads back what the pipeline decided.
   */
  private async execute(
    id: JsonRpcId,
    invocation: A2aInvocation,
  ): Promise<Record<string, unknown>> {
    const context = this.context;
    if (context === undefined) {
      return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, 'A2A adapter is not running.');
    }

    const resource = this.skillsById.get(invocation.resourceId);
    if (resource === undefined) {
      // Identical message whether the resource does not exist or is scoped to
      // another protocol: a caller must not be able to probe for resources
      // this deployment does not expose over A2A.
      return jsonRpcError(
        id,
        JSONRPC_INVALID_PARAMS,
        `Unknown canonical resource "${invocation.resourceId}".`,
      );
    }

    const { input, payment } = extractPaymentSubmission(invocation.input, resource);
    const request: CanonicalRequest = {
      requestId: context.ids.next('a2a'),
      resourceId: invocation.resourceId,
      input,
      protocol: 'a2a',
      receivedAt: context.clock.nowIso(),
      ...(payment !== undefined ? { payment } : {}),
    };

    try {
      return jsonRpcResult(id, this.toResult(await context.pipeline.execute(request)));
    } catch (err) {
      const error = toCommerceError(err);
      context.logger.warn(
        { resourceId: invocation.resourceId, requestId: request.requestId, err: error.toInfo() },
        'a2a adapter: execution failed',
      );
      return jsonRpcError(id, jsonRpcCodeFor(error.code), error.message);
    }
  }

  /**
   * Interim shape: terminal A2A Task mapping arrives with outcome mapping.
   * Both branches use the canonical envelopes rather than an A2A-specific
   * invention, so nothing here has to be unlearned then.
   */
  private toResult(outcome: ExecutionOutcome): Record<string, unknown> {
    if (outcome.kind === 'payment-required') {
      return { ...toPaymentRequiredEnvelope(outcome) };
    }
    return {
      kind: 'delivered',
      resourceId: outcome.resourceId,
      body: outcome.body,
      delivery: toDeliverySummary(outcome),
    };
  }

  async health(): Promise<AdapterHealth> {
    const checkedAt = this.context?.clock.nowIso() ?? new Date().toISOString();
    if (!this.started || this.card === undefined) {
      return { status: 'fail', detail: 'A2A adapter has not been started.', checkedAt };
    }
    return { status: 'pass', detail: `${this.skills.length} skill(s) published.`, checkedAt };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.card = undefined;
    this.skills = [];
    this.skillsById = new Map();
    this.context = undefined;
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': A2A_JSON_MEDIA_TYPE });
    res.end(JSON.stringify(body));
  }
}

/**
 * Commerce failures are not transport failures: a rejected payment or a
 * missing resource is the caller's request being answered, not the frame
 * being wrong. Only the two that genuinely describe the request map to a
 * JSON-RPC param error; everything else stays internal until outcome mapping
 * gives it a task state.
 */
function jsonRpcCodeFor(code: CommerceErrorCode): number {
  switch (code) {
    case 'RESOURCE_NOT_FOUND':
    case 'INPUT_INVALID':
      return JSONRPC_INVALID_PARAMS;
    case 'PROTOCOL_UNSUPPORTED':
      return A2A_ERROR_UNSUPPORTED_OPERATION;
    default:
      return JSONRPC_INTERNAL_ERROR;
  }
}

/**
 * Reads the unconsumed request stream the gateway hands over. Stops at the cap
 * rather than buffering whatever arrives.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) throw new CommerceError('INPUT_INVALID', 'Request body too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createA2aAdapter(options: A2aAdapterOptions = {}): A2aProtocolAdapter {
  return new A2aProtocolAdapter(options);
}
