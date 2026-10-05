/**
 * A2A (Agent2Agent) protocol adapter, experimental.
 *
 * Serves two paths: the configured mount (`/a2a`), where the JSON-RPC endpoint
 * lives, and the specification-fixed `/.well-known/agent-card.json`, declared
 * through `additionalHttpRoutes` so the gateway needs no A2A-specific routing.
 *
 * Only the synchronous `SendMessage` path is served; every other A2A method
 * is listed in `descriptor.unsupported`. This adapter maps reserved payment
 * fields but leaves verification, settlement and merchant calls to the
 * pipeline.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type AdapterHttpRoute,
  type CanonicalRequest,
  CommerceError,
  type CommerceResource,
  type ExecutionOutcome,
  extractReservedInputFields,
  type HttpProtocolAdapter,
  type ProtocolAdapterContext,
  toCommerceError,
} from '../../core';
import { toLogInfo } from '../../core/errors';
import { isRecord } from '../../core/is-record';
import { PACKAGE_VERSION } from '../../version';
import { readCappedBody } from '../http';
import { buildAgentCard } from './agent-card';
import {
  A2A_AGENT_CARD_PATH,
  A2A_DEFAULT_AGENT_NAME,
  A2A_DEFAULT_MOUNT_PATH,
  A2A_EXTENSIONS_HEADER,
  A2A_JSON_MEDIA_TYPE,
  A2A_METHOD_SEND_MESSAGE,
  A2A_PROTOCOL_VERSION,
  A2A_PUSH_CONFIG_METHODS,
  A2A_TASK_LOOKUP_METHODS,
  A2A_TASK_STATE_FAILED,
  A2A_UNSUPPORTED_METHODS,
  A2A_VERSION_HEADER,
} from './constants';
import { buildDescriptor } from './descriptor';
import {
  A2A_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED,
  A2A_ERROR_TASK_NOT_FOUND,
  A2A_ERROR_UNSUPPORTED_OPERATION,
  A2A_ERROR_VERSION_NOT_SUPPORTED,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type JsonRpcId,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpcRequest,
} from './jsonrpc';
import { type A2aInvocation, parseInvocation, userRoleProblem } from './message-mapping';
import {
  completedTask,
  failedTask,
  inputRequired,
  paymentRequiredTask,
  type TaskIdentity,
  withStatusMessage,
} from './task-mapping';
import type { A2aAgentCard, A2aTask } from './types';
import {
  A2A_X402_EXTENSION_URI,
  createPendingPayments,
  type PendingPayment,
  type PendingPayments,
  paymentCompletedMetadata,
  paymentFailureMetadata,
  paymentRejectedMetadata,
  paymentRequiredMetadata,
  readFollowUpAuthorization,
  readPaymentSubmission,
  requestsX402Extension,
  X402_PAYMENT_PAYLOAD_KEY,
  X402_PAYMENT_STATUS_KEY,
} from './x402-extension';

// A second line behind the gateway mount's cap, bounding what this adapter
// buffers if it is mounted without that guard
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

// Accept patch suffixes; only major.minor determines the protocol version
const VERSION_PATTERN = /^(\d+\.\d+)(?:\.\d+)?$/;

// A2A version parameter; the header is matched case-insensitively
const A2A_VERSION_PARAMETER = 'A2A-Version';

// Cache the card until the adapter starts again with new configuration
const AGENT_CARD_CACHE_CONTROL = 'public, max-age=300';

export interface A2aAdapterOptions {
  readonly mountPath?: string;
  /** Agent name published on the card */
  readonly agentName?: string;
  readonly agentDescription?: string;
  /** Version published on the card. Defaults to this package's version */
  readonly agentVersion?: string;
}

const DEFAULT_AGENT_DESCRIPTION =
  'Agent Commerce Gateway: canonical commerce resources exposed as A2A skills.';

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
  // The card lists only a2a-exposed resources, but a caller can name any id,
  // so the adapter refuses another protocol's resource itself
  private skillsById: ReadonlyMap<string, CommerceResource> = new Map();
  // Built once at start: resources are fixed at config load, and a per-request
  // build would be work an unauthenticated GET could trigger at will
  private card: A2aAgentCard | undefined;
  private cardBody = '';
  private cardEtag = '';
  // Purchases waiting for an x402 extension payment
  private pendingPayments: PendingPayments | undefined;

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
        { err: toLogInfo(err) },
        'a2a adapter: failed to list a2a-exposed resources',
      );
      resources = [];
    }

    this.skillsById = new Map(resources.map((resource) => [resource.id, resource]));
    this.card = buildAgentCard({
      name: this.agentName,
      description: this.agentDescription,
      version: this.agentVersion,
      publicBaseUrl: context.publicBaseUrl,
      mountPath: this.mountPath,
      resources,
    });
    this.pendingPayments = createPendingPayments(context.clock);
    this.cardBody = JSON.stringify(this.card);
    this.cardEtag = `"${createHash('sha256').update(this.cardBody).digest('base64url')}"`;
    this.started = true;

    context.logger.info(
      { mountPath: this.mountPath, cardPath: A2A_AGENT_CARD_PATH, skillCount: resources.length },
      'a2a adapter started',
    );
  }

  /** `GET /.well-known/agent-card.json` */
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
      const cacheHeaders = { 'cache-control': AGENT_CARD_CACHE_CONTROL, etag: this.cardEtag };
      if (matchesEtag(req.headers['if-none-match'], this.cardEtag)) {
        res.writeHead(304, cacheHeaders);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': A2A_JSON_MEDIA_TYPE, ...cacheHeaders });
      res.end(this.cardBody);
    } catch (err) {
      this.context?.logger.error({ err: toLogInfo(err) }, 'a2a adapter: agent card request failed');
      this.writeJson(res, 500, { error: 'Internal server error.' });
    }
  }

  /** `POST <mountPath>`: the A2A JSON-RPC endpoint */
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

      const read = await readCappedBody(req, MAX_REQUEST_BODY_BYTES);
      if (read.kind === 'too-large') {
        this.writeJson(
          res,
          413,
          jsonRpcError(
            null,
            JSONRPC_INVALID_REQUEST,
            `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`,
          ),
        );
        return;
      }
      if (read.kind !== 'ok') {
        this.writeJson(
          res,
          200,
          jsonRpcError(null, JSONRPC_PARSE_ERROR, 'Could not read the request body.'),
        );
        return;
      }

      const parsed = parseJsonRpcRequest(read.text);
      if (!parsed.ok) {
        this.writeJson(res, 200, jsonRpcError(parsed.id, parsed.error.code, parsed.error.message));
        return;
      }

      // Parse first to echo the request id on version errors. The query
      // parameter substitutes for an absent version header.
      const version = req.headers[A2A_VERSION_HEADER];
      const declared =
        (Array.isArray(version) ? version[0] : version) ??
        new URL(req.url ?? '/', 'http://localhost').searchParams.get(A2A_VERSION_PARAMETER);
      if (declared?.match(VERSION_PATTERN)?.[1] !== A2A_PROTOCOL_VERSION) {
        this.writeJson(
          res,
          200,
          jsonRpcError(
            parsed.request.id,
            A2A_ERROR_VERSION_NOT_SUPPORTED,
            `Unsupported A2A protocol version. Send the ${A2A_VERSION_PARAMETER} header with "${A2A_PROTOCOL_VERSION}".`,
          ),
        );
        return;
      }

      const response = await this.dispatch(
        parsed.request.id,
        parsed.request.method,
        parsed.request.params,
        requestsX402Extension(req.headers[A2A_EXTENSIONS_HEADER]),
      );
      // Echo the extension when it shaped the task, even without the
      // request header on a payment follow-up
      this.writeJson(
        res,
        200,
        response,
        usesX402Extension(response) ? { [A2A_EXTENSIONS_HEADER]: A2A_X402_EXTENSION_URI } : {},
      );
    } catch (err) {
      // Nothing from `err` reaches the client
      this.context?.logger.error({ err: toLogInfo(err) }, 'a2a adapter: request handling failed');
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
    x402Extension: boolean,
  ): Promise<Record<string, unknown>> {
    if (A2A_PUSH_CONFIG_METHODS.includes(method)) {
      return jsonRpcError(
        id,
        A2A_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED,
        `A2A method "${method}" is not supported: this agent does not support push notifications.`,
      );
    }
    if (A2A_TASK_LOOKUP_METHODS.includes(method)) {
      return jsonRpcError(
        id,
        A2A_ERROR_TASK_NOT_FOUND,
        'Task not found. Finished tasks are not retained; continue a pending payment with SendMessage.',
      );
    }
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

    const resumed = await this.resumePayment(id, params);
    if (resumed !== undefined) return resumed;

    let invocation: ReturnType<typeof parseInvocation>;
    try {
      invocation = parseInvocation(params);
    } catch (err) {
      const error = toCommerceError(err);
      const a2aErrorCode = error.details?.['a2aErrorCode'];
      const code =
        typeof a2aErrorCode === 'number'
          ? a2aErrorCode
          : error.code === 'PROTOCOL_UNSUPPORTED'
            ? A2A_ERROR_UNSUPPORTED_OPERATION
            : JSONRPC_INVALID_PARAMS;
      // CommerceError messages are written for a client; nothing else is
      // relayed
      return jsonRpcError(id, code, error.message);
    }

    return this.execute(id, invocation, x402Extension);
  }

  // One accepted invocation, one `pipeline.execute()`
  private async execute(
    id: JsonRpcId,
    invocation: A2aInvocation,
    x402Extension: boolean,
  ): Promise<Record<string, unknown>> {
    const context = this.context;
    if (context === undefined) {
      return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, 'A2A adapter is not running.');
    }

    const resource = this.skillsById.get(invocation.resourceId);
    if (resource === undefined) {
      // A commerce outcome, so a failed task rather than a JSON-RPC error. It
      // reads the same whether the resource is missing or scoped to another
      // protocol, so a caller cannot probe what A2A does not expose.
      return this.taskResult(
        id,
        failedTask(
          new CommerceError(
            'RESOURCE_NOT_FOUND',
            `Unknown canonical resource "${invocation.resourceId}".`,
          ),
          this.taskIdentity(context, context.ids.next('a2a')),
        ),
      );
    }

    const requestId = context.ids.next('a2a');
    const identity = this.taskIdentity(context, requestId);

    // Reserved-field extraction sits inside the try: a malformed
    // `_authorization` envelope becomes a failed task like any other outcome
    try {
      const { input, payment, authorization } = extractReservedInputFields(
        invocation.input,
        resource,
        requestId,
      );
      const request: CanonicalRequest = {
        requestId,
        resourceId: invocation.resourceId,
        input,
        protocol: 'a2a',
        receivedAt: context.clock.nowIso(),
        ...(payment !== undefined ? { payment } : {}),
        ...(authorization !== undefined ? { authorization } : {}),
      };
      const outcome: ExecutionOutcome = await context.pipeline.execute(request);
      if (outcome.kind !== 'payment-required') {
        return this.taskResult(id, completedTask(outcome, identity));
      }
      const task = paymentRequiredTask(outcome, identity);
      const envelope = outcome.requirement.challenge.envelope;
      // The extension carries x402 only; any other rail keeps the terminal task
      if (!x402Extension || outcome.requirement.provider !== 'x402' || !isRecord(envelope)) {
        return this.taskResult(id, task);
      }
      const network = outcome.requirement.network;
      this.pendingPayments?.put(
        identity.taskId,
        {
          contextId: identity.contextId,
          resourceId: invocation.resourceId,
          input,
          ...(authorization !== undefined ? { authorization } : {}),
          ...(network !== undefined ? { network } : {}),
        },
        outcome.requirement.expiresAt,
      );
      return this.taskResult(
        id,
        inputRequired(task, paymentRequiredMetadata(envelope), identity.statusMessageId),
      );
    } catch (err) {
      // A downstream failure is the caller's answer, not a broken frame.
      // `toCommerceError` replaces a non-commerce error's message, so nothing
      // internal reaches the artifact.
      const error = toCommerceError(err);
      context.logger.warn(
        { resourceId: invocation.resourceId, requestId, err: toLogInfo(error) },
        'a2a adapter: execution failed',
      );
      return this.taskResult(id, failedTask(error, identity));
    }
  }

  /**
   * A message on a task waiting for an x402 extension payment, recognized by
   * its `taskId` whether or not the header activated the extension again. Any
   * other task id falls through to `parseInvocation`, which answers
   * TaskNotFoundError.
   */
  private async resumePayment(
    id: JsonRpcId,
    params: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const context = this.context;
    const message = isRecord(params) ? params['message'] : undefined;
    const taskId = isRecord(message) ? message['taskId'] : undefined;
    if (context === undefined || typeof taskId !== 'string') return undefined;
    const pending = this.pendingPayments?.get(taskId);
    if (pending === undefined) return undefined;

    const messageId = isRecord(message) ? message['messageId'] : undefined;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return jsonRpcError(
        id,
        JSONRPC_INVALID_PARAMS,
        'Message must carry a non-empty "messageId".',
      );
    }
    // Apply the same role check as a new purchase
    const roleProblem = userRoleProblem(isRecord(message) ? message['role'] : undefined);
    if (roleProblem !== undefined) return jsonRpcError(id, JSONRPC_INVALID_PARAMS, roleProblem);
    // Reject a mismatched context without consuming the pending task.
    const contextId = isRecord(message) ? message['contextId'] : undefined;
    if (contextId !== undefined && contextId !== pending.contextId) {
      return jsonRpcError(
        id,
        JSONRPC_INVALID_PARAMS,
        'Message "contextId" does not match the task.',
      );
    }
    const submission = readPaymentSubmission(message);
    if (submission === undefined) {
      // The task stays pending, so a corrected message can still pay it
      return jsonRpcError(
        id,
        JSONRPC_INVALID_PARAMS,
        `For a pending task, set "${X402_PAYMENT_STATUS_KEY}" to "payment-submitted" and provide a "${X402_PAYMENT_PAYLOAD_KEY}" object, or set it to "payment-rejected".`,
      );
    }
    // A mandate stored with the purchase wins. One sent here is verified
    // against the stored resource and input, like the payment.
    let authorization = pending.authorization;
    if (authorization === undefined && submission.kind === 'submitted') {
      try {
        authorization = readFollowUpAuthorization(message);
      } catch (err) {
        return jsonRpcError(id, JSONRPC_INVALID_PARAMS, toCommerceError(err).message);
      }
    }
    // Taken before execution, so a second payment message for the task finds
    // nothing and cannot run the purchase twice
    this.pendingPayments?.delete(taskId);
    const statusMessageId = context.ids.next('a2a-msg');
    const identity: TaskIdentity = {
      taskId,
      contextId: pending.contextId,
      artifactId: context.ids.next('a2a-artifact'),
      statusMessageId,
      timestamp: context.clock.nowIso(),
    };

    if (submission.kind === 'rejected') {
      const declined: A2aTask = {
        id: taskId,
        contextId: pending.contextId,
        status: { state: A2A_TASK_STATE_FAILED, timestamp: identity.timestamp },
        artifacts: [],
      };
      return this.taskResult(
        id,
        withStatusMessage(
          declined,
          'Payment was declined.',
          statusMessageId,
          paymentRejectedMetadata(),
        ),
      );
    }
    return this.taskResult(
      id,
      await this.payPending(
        context,
        { ...pending, ...(authorization !== undefined ? { authorization } : {}) },
        submission.payload,
        identity,
      ),
    );
  }

  // The pending purchase, now with the x402 `PaymentPayload` as its proof
  private async payPending(
    context: ProtocolAdapterContext,
    pending: PendingPayment,
    payload: Record<string, unknown>,
    identity: TaskIdentity,
  ): Promise<A2aTask> {
    const requestId = context.ids.next('a2a');
    const request: CanonicalRequest = {
      requestId,
      resourceId: pending.resourceId,
      input: pending.input,
      protocol: 'a2a',
      receivedAt: context.clock.nowIso(),
      // The same encoding as the HTTP header's base64 PaymentPayload JSON
      payment: {
        method: 'x402',
        payload: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      },
      ...(pending.authorization !== undefined ? { authorization: pending.authorization } : {}),
    };
    let error: CommerceError;
    try {
      const outcome = await context.pipeline.execute(request);
      if (outcome.kind === 'delivered' && outcome.payment !== undefined) {
        return withStatusMessage(
          completedTask(outcome, identity),
          'Payment settled.',
          identity.statusMessageId,
          paymentCompletedMetadata(outcome.payment),
        );
      }
      // A proof was sent, so neither a free delivery nor a new challenge is a
      // payment this task can report
      error = new CommerceError('PAYMENT_INVALID', 'The payment was not accepted.', { requestId });
    } catch (err) {
      error = toCommerceError(err);
      context.logger.warn(
        { resourceId: pending.resourceId, requestId, err: toLogInfo(error) },
        'a2a adapter: x402 extension payment failed',
      );
    }
    const metadata = paymentFailureMetadata(error, pending.network);
    let text = 'Payment failed.';
    if (metadata[X402_PAYMENT_STATUS_KEY] === 'payment-completed') {
      text = 'Payment settled, but the resource could not be delivered.';
    } else if (!error.code.startsWith('PAYMENT_')) {
      text = 'The resource could not be delivered.';
    }
    return withStatusMessage(failedTask(error, identity), text, identity.statusMessageId, metadata);
  }

  private taskIdentity(context: ProtocolAdapterContext, requestId: string): TaskIdentity {
    return {
      taskId: requestId,
      contextId: context.ids.next('a2a-ctx'),
      artifactId: context.ids.next('a2a-artifact'),
      statusMessageId: context.ids.next('a2a-msg'),
      timestamp: context.clock.nowIso(),
    };
  }

  // A2A's JSON-RPC result wraps the terminal task
  private taskResult(id: JsonRpcId, task: A2aTask): Record<string, unknown> {
    return jsonRpcResult(id, { task });
  }

  async health(): Promise<AdapterHealth> {
    const checkedAt = this.context?.clock.nowIso() ?? new Date().toISOString();
    if (!this.started || this.card === undefined) {
      return { status: 'fail', detail: 'A2A adapter has not been started.', checkedAt };
    }
    return { status: 'pass', detail: `${this.skillsById.size} skill(s) published.`, checkedAt };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.card = undefined;
    this.cardBody = '';
    this.cardEtag = '';
    this.pendingPayments?.clear();
    this.pendingPayments = undefined;
    this.skillsById = new Map();
    this.context = undefined;
  }

  private writeJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': A2A_JSON_MEDIA_TYPE, ...headers });
    res.end(JSON.stringify(body));
  }
}

// True when the response is a task whose status message lists the extension
function usesX402Extension(response: Record<string, unknown>): boolean {
  const result = response['result'] as { readonly task?: A2aTask } | undefined;
  return result?.task?.status.message?.extensions?.includes(A2A_X402_EXTENSION_URI) === true;
}

// Compare entity tags weakly; `*` matches any current card
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag);
}

export function createA2aAdapter(options: A2aAdapterOptions = {}): A2aProtocolAdapter {
  return new A2aProtocolAdapter(options);
}
