/**
 * A2A (Agent2Agent) protocol adapter.
 *
 * Serves two paths: the configured mount (`/a2a`), where the JSON-RPC endpoint
 * lives, and the specification-fixed `/.well-known/agent-card.json`, declared
 * through `additionalHttpRoutes` so the gateway needs no A2A-specific routing.
 *
 * `SendMessage` blocks by default and supports background execution with
 * `returnImmediately`.
 * `GetTask` and `ListTasks` read retained tasks; `CancelTask` ends pending
 * payments. Other A2A methods are listed in `descriptor.unsupported`.
 * This adapter maps reserved payment fields but leaves verification,
 * settlement and merchant calls to the pipeline.
 */
import { createHash, randomUUID } from 'node:crypto';
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
  type ReceiptStore,
  toCommerceError,
} from '../../core';
import { toLogInfo } from '../../core/errors';
import { isRecord } from '../../core/is-record';
import { hasMethodGroup } from '../../core/store-method-groups';
import { PACKAGE_VERSION } from '../../version';
import { readCappedBody } from '../http';
import { buildAgentCard } from './agent-card';
import { type BackgroundRuns, createBackgroundRuns } from './background';
import {
  A2A_AGENT_CARD_PATH,
  A2A_DEFAULT_AGENT_NAME,
  A2A_DEFAULT_MOUNT_PATH,
  A2A_EXTENSIONS_HEADER,
  A2A_JSON_MEDIA_TYPE,
  A2A_MAX_BACKGROUND_RUNS,
  A2A_MAX_RETAINED_TASKS,
  A2A_METHOD_CANCEL_TASK,
  A2A_METHOD_GET_TASK,
  A2A_METHOD_LIST_TASKS,
  A2A_METHOD_SEND_MESSAGE,
  A2A_PROTOCOL_VERSION,
  A2A_PUSH_CONFIG_METHODS,
  A2A_TASK_RETENTION_HOURS,
  A2A_UNSUPPORTED_METHODS,
  A2A_VERSION_HEADER,
  A2A_X_EXTENSIONS_HEADER,
} from './constants';
import { buildDescriptor } from './descriptor';
import {
  A2A_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED,
  A2A_ERROR_UNSUPPORTED_OPERATION,
  A2A_ERROR_VERSION_NOT_SUPPORTED,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type JsonRpcId,
  jsonRpcError,
  parseJsonRpcRequest,
} from './jsonrpc';
import { type A2aInvocation, parseInvocation, readMessage } from './message-mapping';
import {
  readCancelTaskParams,
  readGetTaskParams,
  readListTasksParams,
  readSendMessageParams,
  type SendMessageParams,
} from './params';
import { BACKGROUND_FULL, type PaymentResume, resumePayment, taskResult } from './payment-resume';
import {
  chargedNothing,
  completedTask,
  failedTask,
  inputRequired,
  paymentRequiredTask,
  type TaskIdentity,
  workingTask,
} from './task-mapping';
import { cancelTask, getTask, listTasks, type TaskOperations } from './task-operations';
import { type A2aTaskStore, createMemoryTasks, createStoredTasks } from './task-store';
import type { A2aAgentCard, A2aTask } from './types';
import {
  A2A_X402_EXTENSION_URI,
  createPendingPayments,
  createStoredPendingPayments,
  type PendingPayments,
  paymentRequiredMetadata,
  pendingExpiresAt,
  requestsX402Extension,
} from './x402-extension';

// A second line behind the gateway mount's cap, bounding what this adapter
// buffers if it is mounted without that guard
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

// Accept patch suffixes; only major.minor determines the protocol version
const VERSION_PATTERN = /^(\d+\.\d+)(?:\.\d+)?$/;

// A2A version parameter; the header is matched case-insensitively
const A2A_VERSION_PARAMETER = 'A2A-Version';

// Echo activation under both accepted names so clients can read either header
const X402_EXTENSION_ECHO = {
  [A2A_EXTENSIONS_HEADER]: A2A_X402_EXTENSION_URI,
  [A2A_X_EXTENSIONS_HEADER]: A2A_X402_EXTENSION_URI,
};

// Cache the card until the adapter starts again with new configuration
const AGENT_CARD_CACHE_CONTROL = 'public, max-age=300';

export interface A2aAdapterOptions {
  readonly mountPath?: string;
  /** Agent name published on the card */
  readonly agentName?: string;
  readonly agentDescription?: string;
  /** Version published on the card. Defaults to this package's version */
  readonly agentVersion?: string;
  /**
   * Store task responses through the complete `task_records` group and unpaid
   * x402 purchases through the complete `pending_tasks` group. Each missing
   * group falls back to process memory. A durable store can preserve unexpired
   * records across restarts. The caller owns and closes the store.
   */
  readonly store?: ReceiptStore;
  /**
   * Task retention in hours (default 24, range 1 to 8760) and the limit on
   * unexpired records when admitting new tasks (default 1000, range 1 to
   * 1,000,000). At capacity, a new record evicts eligible uncharged responses
   * or is refused if too few are available. Existing IDs can still be replaced.
   */
  readonly tasks?: { readonly retentionHours?: number; readonly maxRetained?: number };
}

// Validate an integer option against its bounds, using the default when omitted
function taskLimit(
  value: number | undefined,
  name: string,
  bounds: { readonly min: number; readonly max: number; readonly default: number },
): number {
  if (value === undefined) return bounds.default;
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `A2A adapter option "tasks.${name}" must be an integer from ${bounds.min} to ${bounds.max}`,
      { details: { path: `tasks.${name}` } },
    );
  }
  return value;
}

// Capacity error for a task record that does not fit
function storeFull(): CommerceError {
  return new CommerceError('GATEWAY_BUSY', 'Too many answered tasks are retained; retry shortly.');
}

// Reject invalid parameters before running an operation that reads tasks
async function withParams<P>(
  id: JsonRpcId,
  read: () => P,
  run: (params: P) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let params: P;
  try {
    params = read();
  } catch (err) {
    return refusal(id, err);
  }
  return run(params);
}

// Map parameter and message failures to JSON-RPC errors. Keep CommerceError
// messages; use a generic message for other thrown values.
function refusal(id: JsonRpcId, err: unknown): Record<string, unknown> {
  const error = toCommerceError(err);
  const a2aErrorCode = error.details?.['a2aErrorCode'];
  const code =
    typeof a2aErrorCode === 'number'
      ? a2aErrorCode
      : error.code === 'PROTOCOL_UNSUPPORTED'
        ? A2A_ERROR_UNSUPPORTED_OPERATION
        : JSONRPC_INVALID_PARAMS;
  return jsonRpcError(id, code, error.message);
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
  private readonly store: ReceiptStore | undefined;
  private readonly retentionMs: number;
  private readonly maxRetained: number;

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
  // Retained responses for task lookup, listing and cancellation
  private tasks: A2aTaskStore | undefined;
  // Active task ids; see TaskOperations.running
  private readonly running = new Set<string>();
  private background: BackgroundRuns | undefined;

  constructor(options: A2aAdapterOptions = {}) {
    this.mountPath = options.mountPath ?? A2A_DEFAULT_MOUNT_PATH;
    this.agentName = options.agentName ?? A2A_DEFAULT_AGENT_NAME;
    this.agentDescription = options.agentDescription ?? DEFAULT_AGENT_DESCRIPTION;
    this.agentVersion = options.agentVersion ?? PACKAGE_VERSION;
    this.store = options.store;
    this.retentionMs =
      taskLimit(options.tasks?.retentionHours, 'retentionHours', A2A_TASK_RETENTION_HOURS) *
      3_600_000;
    this.maxRetained = taskLimit(options.tasks?.maxRetained, 'maxRetained', A2A_MAX_RETAINED_TASKS);
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
    // A store holds pending tasks only if it implements the whole group
    this.pendingPayments = hasMethodGroup(this.store, 'pending_tasks')
      ? createStoredPendingPayments(this.store, context.clock)
      : createPendingPayments(context.clock);
    this.tasks = hasMethodGroup(this.store, 'task_records')
      ? createStoredTasks(this.store, this.maxRetained)
      : createMemoryTasks(context.clock, this.maxRetained);
    this.background = createBackgroundRuns(A2A_MAX_BACKGROUND_RUNS, context.logger);
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
    // Echo the parsed request id if later processing fails
    let requestId: JsonRpcId = null;
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
      requestId = parsed.request.id;

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

      const activated =
        requestsX402Extension(req.headers[A2A_EXTENSIONS_HEADER]) ||
        requestsX402Extension(req.headers[A2A_X_EXTENSIONS_HEADER]);
      const response = await this.dispatch(
        parsed.request.id,
        parsed.request.method,
        parsed.request.params,
        activated,
      );
      // Echo activation on JSON-RPC results for any rail (a2a-x402 v0.1 section 7).
      // A task's extension marker also triggers the echo on payment follow-ups
      // without activation headers. JSON-RPC errors do not echo activation.
      const echo = usesX402Extension(response) || (activated && response['error'] === undefined);
      this.writeJson(res, 200, response, echo ? X402_EXTENSION_ECHO : {});
    } catch (err) {
      // Nothing from `err` reaches the client
      this.context?.logger.error({ err: toLogInfo(err) }, 'a2a adapter: request handling failed');
      this.writeJson(
        res,
        200,
        jsonRpcError(requestId, JSONRPC_INTERNAL_ERROR, 'Internal server error.'),
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
    if (A2A_UNSUPPORTED_METHODS.includes(method)) {
      return jsonRpcError(
        id,
        A2A_ERROR_UNSUPPORTED_OPERATION,
        `A2A method "${method}" is not supported by this deployment.`,
      );
    }
    const raw = isRecord(params) ? params : {};
    const ops = this.operations();
    switch (method) {
      case A2A_METHOD_SEND_MESSAGE:
        break;
      case A2A_METHOD_GET_TASK:
        return withParams(
          id,
          () => readGetTaskParams(raw),
          (read) => getTask(ops, id, read),
        );
      case A2A_METHOD_LIST_TASKS:
        return withParams(
          id,
          () => readListTasksParams(raw),
          (read) => listTasks(ops, id, read),
        );
      case A2A_METHOD_CANCEL_TASK:
        return withParams(
          id,
          () => readCancelTaskParams(raw),
          (read) => cancelTask(ops, id, read),
        );
      default:
        return jsonRpcError(id, JSONRPC_METHOD_NOT_FOUND, `Unknown method "${method}".`);
    }

    let request: SendMessageParams;
    try {
      request = readSendMessageParams(raw);
      readMessage(request.params);
    } catch (err) {
      return refusal(id, err);
    }

    const resumed = await resumePayment(
      this.resume(ops),
      id,
      request.params,
      request.returnImmediately,
    );
    if (resumed !== undefined) return resumed;
    const known = await this.answerKnownTask(ops, id, request.params);
    if (known !== undefined) return known;

    let invocation: ReturnType<typeof parseInvocation>;
    try {
      invocation = parseInvocation(request.params);
    } catch (err) {
      return refusal(id, err);
    }

    return this.execute(ops, id, invocation, x402Extension, request.returnImmediately);
  }

  // Collect task-operation state after startup; handleHttp returns 503 before startup
  private operations(): TaskOperations {
    const { context, tasks, pendingPayments } = this;
    if (context === undefined || tasks === undefined || pendingPayments === undefined) {
      throw new CommerceError('INTERNAL_ERROR', 'A2A adapter is not running.');
    }
    return {
      tasks,
      pendingPayments,
      running: this.running,
      clock: context.clock,
      retainedUntil: () => this.retainedUntil(context),
      nextMessageId: () => context.ids.next('a2a-msg'),
    };
  }

  private resume(ops: TaskOperations): PaymentResume {
    const { context, background } = this;
    if (context === undefined || background === undefined) {
      throw new CommerceError('INTERNAL_ERROR', 'A2A adapter is not running.');
    }
    return {
      context,
      pendingPayments: ops.pendingPayments,
      keep: (task, evictable) => this.keep(ops, task, evictable),
      running: this.running,
      background,
      recordWorking: (task) => this.recordWorking(ops, task),
    };
  }

  private retainedUntil(context: ProtocolAdapterContext): string {
    return new Date(context.clock.now().getTime() + this.retentionMs).toISOString();
  }

  // Retain a response without failing the call. Log capacity refusals at warn
  // and write exceptions at error; return false in either case.
  private async keep(ops: TaskOperations, task: A2aTask, evictable: boolean): Promise<boolean> {
    const logger = this.context?.logger;
    try {
      if (await ops.tasks.put(task, ops.retainedUntil(), evictable)) return true;
      logger?.warn(
        { state: task.status.state },
        'a2a adapter: task not retained: the task store is full',
      );
    } catch (err) {
      logger?.error(
        { state: task.status.state, err: toLogInfo(err) },
        'a2a adapter: task not retained',
      );
    }
    return false;
  }

  // Store the working response before starting background work; return any
  // failure so the caller can stop admission
  private async recordWorking(
    ops: TaskOperations,
    task: A2aTask,
  ): Promise<CommerceError | undefined> {
    try {
      return (await ops.tasks.put(task, ops.retainedUntil())) ? undefined : storeFull();
    } catch (err) {
      this.context?.logger.error({ err: toLogInfo(err) }, 'a2a adapter: working task not recorded');
      return toCommerceError(err);
    }
  }

  /**
   * Reject further messages on a retained task after the pending-payment path
   * declines it, including tasks taken by another call. Terminal tasks accept
   * no further messages (A2A 1.0.1 section 3.1.1). Missing records fall through
   * to `parseInvocation`, which returns `TaskNotFoundError`.
   */
  private async answerKnownTask(
    ops: TaskOperations,
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const message = params['message'];
    const taskId = isRecord(message) ? message['taskId'] : undefined;
    if (typeof taskId !== 'string') return undefined;
    const task = await ops.tasks.get(taskId);
    if (task === undefined) return undefined;
    const contextId = isRecord(message) ? message['contextId'] : undefined;
    if (contextId !== undefined && contextId !== task.contextId) {
      return jsonRpcError(
        id,
        JSONRPC_INVALID_PARAMS,
        'Message "contextId" does not match the task.',
      );
    }
    return jsonRpcError(
      id,
      A2A_ERROR_UNSUPPORTED_OPERATION,
      'This task accepts no further messages: send a new message without a taskId.',
    );
  }

  // Return the purchase result, or a stored working task for returnImmediately
  private async execute(
    ops: TaskOperations,
    id: JsonRpcId,
    invocation: A2aInvocation,
    x402Extension: boolean,
    returnImmediately: boolean,
  ): Promise<Record<string, unknown>> {
    const { context, background } = this;
    if (context === undefined || background === undefined) {
      return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, 'A2A adapter is not running.');
    }
    const ids = this.taskIds(context);
    const now = (): TaskIdentity => ({ ...ids, timestamp: context.clock.nowIso() });

    const resource = this.skillsById.get(invocation.resourceId);
    if (resource === undefined) {
      // A commerce outcome, so a failed task rather than a JSON-RPC error. It
      // reads the same whether the resource is missing or scoped to another
      // protocol, so a caller cannot probe what A2A does not expose.
      const unknown = failedTask(
        new CommerceError(
          'RESOURCE_NOT_FOUND',
          `Unknown canonical resource "${invocation.resourceId}".`,
        ),
        now(),
      );
      await this.keep(ops, unknown, true);
      return taskResult(id, unknown);
    }
    const run = () => this.purchase(ops, context, ids, invocation, resource, x402Extension);
    if (!returnImmediately) return taskResult(id, await run());

    // Return the busy task without retaining it; no purchase has started
    if (!background.reserve()) {
      return taskResult(id, failedTask(new CommerceError('GATEWAY_BUSY', BACKGROUND_FULL), now()));
    }
    const working = workingTask(ids.taskId, ids.contextId, context.clock.nowIso());
    // Add the running entry before publishing the working record
    this.running.add(ids.taskId);
    const refused = await this.recordWorking(ops, working);
    if (refused !== undefined) {
      this.running.delete(ids.taskId);
      background.release();
      return taskResult(id, failedTask(refused, now()));
    }
    background.start(async () => {
      try {
        await run();
      } finally {
        this.running.delete(ids.taskId);
      }
    });
    return taskResult(id, working);
  }

  // Execute the purchase through the pipeline and retain its response when possible
  private async purchase(
    ops: TaskOperations,
    context: ProtocolAdapterContext,
    ids: Omit<TaskIdentity, 'timestamp'>,
    invocation: A2aInvocation,
    resource: CommerceResource,
    x402Extension: boolean,
  ): Promise<A2aTask> {
    const now = (): TaskIdentity => ({ ...ids, timestamp: context.clock.nowIso() });
    const requestId = context.ids.next('a2a');
    let task: A2aTask;
    let evictable = true;
    let proofSent = false;
    // Reserved-field extraction sits inside the try: a malformed
    // `_authorization` envelope becomes a failed task like any other outcome
    try {
      const { input, payment, authorization } = extractReservedInputFields(
        invocation.input,
        resource,
        requestId,
      );
      proofSent = payment !== undefined;
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
      const identity = now();
      if (outcome.kind !== 'payment-required') {
        task = completedTask(outcome, identity);
        evictable = outcome.payment === undefined;
      } else {
        task = paymentRequiredTask(outcome, identity);
        const envelope = outcome.requirement.challenge.envelope;
        // The extension carries x402 only; any other rail keeps the terminal task
        if (x402Extension && outcome.requirement.provider === 'x402' && isRecord(envelope)) {
          const network = outcome.requirement.network;
          return await this.awaitPayment(
            ops,
            identity,
            inputRequired(task, paymentRequiredMetadata(envelope), identity.statusMessageId),
            {
              contextId: identity.contextId,
              resourceId: invocation.resourceId,
              input,
              ...(authorization !== undefined ? { authorization } : {}),
              ...(network !== undefined ? { network } : {}),
            },
            pendingExpiresAt(context.clock.now().getTime(), outcome.requirement.expiresAt),
          );
        }
      }
    } catch (err) {
      // A downstream failure is the caller's answer, not a broken frame.
      // `toCommerceError` replaces a non-commerce error's message, so nothing
      // internal reaches the artifact.
      const error = toCommerceError(err);
      context.logger.warn(
        { resourceId: invocation.resourceId, requestId, err: toLogInfo(error) },
        'a2a adapter: execution failed',
      );
      task = failedTask(error, now());
      evictable = chargedNothing(error, proofSent);
    }
    await this.keep(ops, task, evictable);
    return task;
  }

  /**
   * Record the input-required response before holding its pending purchase,
   * using the same expiry. Refuse the purchase if the record does not fit.
   * If pending storage throws, `execute` returns a failed task and attempts
   * to replace the waiting response with it.
   */
  private async awaitPayment(
    ops: TaskOperations,
    identity: TaskIdentity,
    waiting: A2aTask,
    purchase: Parameters<PendingPayments['put']>[1],
    expiresAt: string,
  ): Promise<A2aTask> {
    if (!(await ops.tasks.put(waiting, expiresAt))) {
      // Capacity also prevents retaining this failure response
      return failedTask(storeFull(), identity);
    }
    if (!(await ops.pendingPayments.put(waiting.id, purchase, expiresAt))) {
      const busy = failedTask(
        new CommerceError(
          'GATEWAY_BUSY',
          'Too many unpaid purchases are waiting for payment; retry shortly.',
        ),
        identity,
      );
      await this.keep(ops, busy, true);
      return busy;
    }
    return waiting;
  }

  // Generate access keys independently of IdGenerator; keep them out of log fields
  private taskIds(context: ProtocolAdapterContext): Omit<TaskIdentity, 'timestamp'> {
    return {
      taskId: randomUUID(),
      contextId: randomUUID(),
      artifactId: context.ids.next('a2a-artifact'),
      statusMessageId: context.ids.next('a2a-msg'),
    };
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
    // Wait for background work to settle before releasing adapter state
    await this.background?.settled();
    this.background = undefined;
    this.card = undefined;
    this.cardBody = '';
    this.cardEtag = '';
    this.pendingPayments?.clear();
    this.pendingPayments = undefined;
    this.tasks = undefined;
    this.running.clear();
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

// True when the response is a task whose status message lists the extension:
// `{ task }` from SendMessage, or the task itself from GetTask
function usesX402Extension(response: Record<string, unknown>): boolean {
  const result = response['result'];
  const task = (isRecord(result) && isRecord(result['task']) ? result['task'] : result) as
    | Partial<A2aTask>
    | undefined;
  return task?.status?.message?.extensions?.includes(A2A_X402_EXTENSION_URI) === true;
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
