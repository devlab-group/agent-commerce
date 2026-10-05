/**
 * MCP protocol adapter.
 *
 * One MCP tool per mcp-exposed canonical resource. Every `tools/call` builds a
 * `CanonicalRequest` and goes through `context.pipeline.execute()`. This
 * adapter reads payment carriers but leaves verification, settlement and
 * merchant calls to the pipeline.
 *
 * The SDK's `createMcpHandler` serves `2026-07-28` over Streamable HTTP and
 * routes 2025-era requests through its stateless fallback. It creates a
 * low-level `Server` for each request. This adapter converts the gateway's
 * Node request and response to the web types the handler uses, without adding
 * `@modelcontextprotocol/node` as a peer.
 *
 * Tools are registered on the low-level `Server`, not through
 * `McpServer.registerTool`, whose `inputSchema` accepts only a Zod schema or
 * shape. `CommerceResource.inputSchema` and the MCP wire `Tool.inputSchema`
 * are both JSON Schema, so building `Tool` objects directly carries the schema
 * through with no lossy conversion. The SDK marks `Server` `@deprecated` but
 * still documents it for advanced cases such as this one.
 *
 * The gateway's `onRequest` hook validates Host and Origin for every route,
 * including `/mcp`. This adapter has no separate allowlist. When mounted
 * outside the gateway, it provides no Host or Origin checks; its descriptor
 * therefore lists `dns-rebinding-protection` as unsupported.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool,
} from '@modelcontextprotocol/server';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type CanonicalRequest,
  CommerceError,
  type CommerceResource,
  extractReservedInputFields,
  type HttpProtocolAdapter,
  type PaymentSubmission,
  type ProtocolAdapterContext,
  toCommerceError,
} from '../../core';
import { toLogInfo } from '../../core/errors';
import { isRecord } from '../../core/is-record';
import { MPP_MCP_CREDENTIAL_META_KEY } from '../../payments/mpp/transport';
import { X402_MCP_PAYMENT_META_KEY, x402McpPaymentSubmission } from '../../payments/x402/transport';
import { PACKAGE_VERSION } from '../../version';
import { readCappedBody } from '../http';
import { MCP_MODERN_PROTOCOL_REVISION, MCP_TOOL_NAME_PATTERN } from './constants';
import { buildDescriptor } from './descriptor';
import { errorResult, mapOutcome } from './result-mapping';
import { buildInputSchema, buildToolDescription, isValidToolName } from './tool-mapping';

export interface McpAdapterOptions {
  /** Path prefix the gateway mounts this adapter at. Default '/mcp' */
  readonly mountPath?: string;
  /** MCP `Implementation.name` reported during initialize */
  readonly serverName?: string;
  /** MCP `Implementation.version` reported during initialize. Default: this package's version */
  readonly serverVersion?: string;
}

interface RegisteredTool {
  readonly resource: CommerceResource;
  readonly tool: Tool;
}

interface SkippedResource {
  readonly id: string;
  readonly reason: string;
}

const DEFAULT_MOUNT_PATH = '/mcp';
const DEFAULT_SERVER_NAME = 'agent-commerce';

/**
 * The SDK can dispatch several `tools/call` requests in one JSON-RPC batch
 * before earlier calls settle. One POST can therefore start concurrent
 * `pipeline.execute()` calls. Limit active calls to 8 per adapter instance.
 */
const MAX_CONCURRENT_TOOL_CALLS = 8;

// A second line behind the gateway mount's cap, bounding what this adapter
// buffers if it is mounted without that guard
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/**
 * Bounds the queue behind the semaphore, per adapter instance. Without it an
 * oversized batch would queue in full and then run in full. 64 is 8x
 * MAX_CONCURRENT_TOOL_CALLS, room for a legitimate burst; calls beyond it fail
 * fast with GATEWAY_BUSY and reach no backend.
 */
const MAX_QUEUED_TOOL_CALLS = 64;

// Batch revision used by the SDK when no protocol-version header is sent
const MCP_BATCH_PROTOCOL_REVISION = '2025-03-26';

// The tool list is public and stable until restart; cache it for a minute
const TOOLS_LIST_CACHE_HINT = { ttlMs: 60_000, cacheScope: 'public' } as const;

class McpProtocolAdapter implements HttpProtocolAdapter {
  readonly name = 'mcp' as const;
  readonly mountPath: string;
  readonly descriptor: AdapterDescriptor;

  private readonly serverName: string;
  private readonly serverVersion: string;

  private context: ProtocolAdapterContext | undefined;
  private started = false;
  private tools: readonly RegisteredTool[] = [];
  private toolsByResourceId: ReadonlyMap<string, CommerceResource> = new Map();
  private skipped: readonly SkippedResource[] = [];
  private handler: McpHttpHandler | undefined;

  // Counting semaphore on `pipeline.execute()`. It lives on the adapter, not
  // the request, so the cap holds across concurrent `/mcp` requests as well
  // as within one batch.
  private inFlightToolCalls = 0;
  private readonly toolCallWaiters: Array<() => void> = [];

  constructor(options: McpAdapterOptions = {}) {
    this.mountPath = options.mountPath ?? DEFAULT_MOUNT_PATH;
    this.serverName = options.serverName ?? DEFAULT_SERVER_NAME;
    this.serverVersion = options.serverVersion ?? PACKAGE_VERSION;
    this.descriptor = buildDescriptor(PACKAGE_VERSION);
  }

  async start(context: ProtocolAdapterContext): Promise<void> {
    this.context = context;
    this.started = false;

    let resources: readonly CommerceResource[] = [];
    try {
      resources = context.resources.listExposedVia('mcp');
    } catch (err) {
      context.logger.error(
        { adapter: 'mcp', err: toLogInfo(err) },
        'mcp adapter: failed to list mcp-exposed resources',
      );
      resources = [];
    }

    const tools: RegisteredTool[] = [];
    const toolsByResourceId = new Map<string, CommerceResource>();
    const skipped: SkippedResource[] = [];

    for (const resource of resources) {
      try {
        if (!isValidToolName(resource.id)) {
          skipped.push({
            id: resource.id,
            reason: `resource id is not a legal MCP tool name (must match ${MCP_TOOL_NAME_PATTERN.source})`,
          });
          continue;
        }
        if (toolsByResourceId.has(resource.id)) {
          skipped.push({ id: resource.id, reason: 'duplicate tool name' });
          continue;
        }
        const tool: Tool = {
          name: resource.id,
          description: buildToolDescription(resource),
          inputSchema: buildInputSchema(resource),
        };
        tools.push({ resource, tool });
        toolsByResourceId.set(resource.id, resource);
      } catch (err) {
        skipped.push({
          id: resource.id,
          reason: `failed to build MCP tool: ${toCommerceError(err).message}`,
        });
      }
    }

    for (const s of skipped) {
      context.logger.warn(
        { adapter: 'mcp', resourceId: s.id, reason: s.reason },
        'mcp adapter: resource skipped',
      );
    }

    this.tools = tools;
    this.toolsByResourceId = toolsByResourceId;
    this.skipped = skipped;
    // Route 2025-era requests through the SDK's stateless fallback
    this.handler = createMcpHandler(
      (ctx) => this.buildServer(ctx.requestInfo?.signal ?? new AbortController().signal),
      {
        legacy: 'stateless',
        // Reporting only: a request the SDK rejects is already answered
        onerror: (err) =>
          context.logger.debug({ adapter: 'mcp', err: toLogInfo(err) }, 'mcp adapter: SDK error'),
      },
    );
    this.started = true;

    context.logger.info(
      {
        adapter: 'mcp',
        mountPath: this.mountPath,
        toolCount: tools.length,
        skippedCount: skipped.length,
      },
      'mcp adapter started',
    );
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.started || !this.context || !this.handler) {
        this.writeJsonRpcError(res, 503, 'MCP adapter is not running.');
        return;
      }
      if (req.method !== 'POST') {
        this.writeJsonRpcError(res, 405, 'Method not allowed. This endpoint only accepts POST.');
        return;
      }

      // Aborted when the response closes. `handleToolCall` checks it only
      // before `pipeline.execute()`: a call that may already have settled
      // must finish, or the buyer is charged for nothing.
      const abortController = new AbortController();
      res.once('close', () => abortController.abort());
      const read = await readCappedBody(req, MAX_REQUEST_BODY_BYTES);
      if (read.kind === 'too-large') {
        this.writeJsonRpcError(
          res,
          413,
          `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`,
        );
        return;
      }
      if (read.kind !== 'ok') {
        this.writeJsonRpcError(res, 400, 'Could not read the request body.');
        return;
      }
      const body = parseJson(read.text);
      const version = req.headers['mcp-protocol-version'];
      if (Array.isArray(body) && version !== undefined && version !== MCP_BATCH_PROTOCOL_REVISION) {
        this.writeJsonRpcError(
          res,
          400,
          `Invalid Request: JSON-RPC batches are supported only in MCP ${MCP_BATCH_PROTOCOL_REVISION}.`,
        );
        return;
      }
      const malformed = isModernRequest(req) ? undefined : malformedToolCall(body);
      if (malformed !== undefined) {
        this.writeJsonRpcError(res, 200, malformed.message, -32602, malformed.id);
        return;
      }
      const response = await this.handler.fetch(
        toWebRequest(req, read.text, abortController.signal),
      );
      await writeWebResponse(response, res);
    } catch (err) {
      this.context?.logger.error(
        { adapter: 'mcp', err: toLogInfo(err) },
        'mcp adapter: request handling failed',
      );
      this.writeJsonRpcError(res, 500, 'Internal server error.');
    }
  }

  async health(): Promise<AdapterHealth> {
    const checkedAt = this.context?.clock.nowIso() ?? new Date().toISOString();
    if (!this.started || !this.context) {
      return { status: 'fail', detail: 'MCP adapter has not been started.', checkedAt };
    }
    const toolCount = this.tools.length;
    if (this.skipped.length > 0) {
      const detail = `${toolCount} tool(s) registered; ${this.skipped.length} resource(s) skipped: ${this.skipped
        .map((s) => `${s.id} (${s.reason})`)
        .join('; ')}`;
      return { status: 'warn', detail, checkedAt };
    }
    return { status: 'pass', detail: `${toolCount} tool(s) registered.`, checkedAt };
  }

  async stop(): Promise<void> {
    this.started = false;
    const handler = this.handler;
    this.handler = undefined;
    try {
      await handler?.close();
    } catch {
      // Best effort: stop() must be idempotent and never throw
    }
    this.context = undefined;
  }

  // Use general JSON-RPC codes for transport errors
  private writeJsonRpcError(
    res: ServerResponse,
    status: number,
    message: string,
    code = status >= 500 ? -32603 : -32600,
    id: string | number | null = null,
  ): void {
    if (res.headersSent) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      // RFC 9110 requires Allow on a 405, and this endpoint takes only POST
      ...(status === 405 ? { allow: 'POST' } : {}),
    });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }));
  }

  private buildServer(signal: AbortSignal): Server {
    const server = new Server(
      { name: this.serverName, version: this.serverVersion },
      { capabilities: { tools: {} }, cacheHints: { 'tools/list': TOOLS_LIST_CACHE_HINT } },
    );
    server.setRequestHandler('tools/list', async (request) => {
      // A cursor is invalid because this list is not paginated
      if (request.params?.cursor !== undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor.');
      }
      return { tools: this.tools.map((t) => t.tool) };
    });
    server.setRequestHandler('tools/call', async (request) =>
      this.handleToolCall(
        request.params.name,
        request.params.arguments ?? {},
        request.params._meta,
        signal,
      ),
    );
    return server;
  }

  private async handleToolCall(
    resourceId: string,
    rawArgs: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const context = this.context;
    if (!context) {
      return errorResult(new CommerceError('INTERNAL_ERROR', 'MCP adapter is not running.'));
    }
    // Clients can call names absent from `tools/list`. Return the same MCP
    // error for unknown and non-MCP resources without revealing the latter
    const resource = this.toolsByResourceId.get(resourceId);
    if (!resource) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool "${resourceId}".`);
    }
    try {
      const requestId = context.ids.next('mcp');
      const fields = extractReservedInputFields(rawArgs, resource, requestId);
      const { input, authorization } = fields;
      // Client wrappers attach proofs in `_meta`; that proof takes priority
      // over a possible `_payment` placeholder in the arguments
      const payment = paymentFromMeta(meta, resource) ?? fields.payment;
      const request: CanonicalRequest = {
        requestId,
        resourceId,
        input,
        protocol: 'mcp',
        receivedAt: context.clock.nowIso(),
        ...(payment !== undefined ? { payment } : {}),
        ...(authorization !== undefined ? { authorization } : {}),
      };
      await this.acquireToolCallSlot(signal);
      try {
        // The last cancellation point: a queued call whose caller has left
        // must not start a pipeline run, while a started one may reach
        // settle() and must finish
        if (signal.aborted) {
          // No error code names "the caller left". PROTOCOL_UNSUPPORTED is the
          // closest non-retryable one; GATEWAY_BUSY would invite a retry
          // nobody is left to make.
          return errorResult(
            new CommerceError(
              'PROTOCOL_UNSUPPORTED',
              'Client disconnected before this call started.',
            ),
          );
        }
        const outcome = await context.pipeline.execute(request);
        return mapOutcome(outcome);
      } finally {
        // Always released: a stranded permit shrinks the cap for good and
        // eventually deadlocks the adapter
        this.releaseToolCallSlot();
      }
    } catch (err) {
      const error = toCommerceError(err);
      context.logger.warn(
        { adapter: 'mcp', resourceId, err: toLogInfo(error) },
        'mcp adapter: execution failed',
      );
      return errorResult(error, resource.paymentMethods[0]);
    }
  }

  /**
   * Takes a permit, or queues for one when MAX_CONCURRENT_TOOL_CALLS are in
   * flight. Throws when the queue is full or the caller disconnected while
   * queued; a throw never leaks a permit.
   */
  private async acquireToolCallSlot(signal: AbortSignal): Promise<void> {
    if (this.inFlightToolCalls < MAX_CONCURRENT_TOOL_CALLS) {
      this.inFlightToolCalls++;
      return;
    }
    if (this.toolCallWaiters.length >= MAX_QUEUED_TOOL_CALLS) {
      // Load shedding is transient, so GATEWAY_BUSY tells the caller to back
      // off and retry
      throw new CommerceError(
        'GATEWAY_BUSY',
        'Too many tool calls already queued on this adapter; retry later.',
      );
    }
    // Resolved by releaseToolCallSlot, which hands its permit straight to the
    // oldest waiter, so a call arriving later cannot take it first
    await new Promise<void>((resolve) => this.toolCallWaiters.push(resolve));
    if (signal.aborted) {
      // This waiter now holds a permit it will not use; pass it on
      this.releaseToolCallSlot();
      // Non-retryable, for the same reason as the check in handleToolCall
      throw new CommerceError('PROTOCOL_UNSUPPORTED', 'Client disconnected while queued.');
    }
  }

  private releaseToolCallSlot(): void {
    const next = this.toolCallWaiters.shift();
    // Handing the permit over leaves the in-flight count unchanged
    if (next !== undefined) next();
    else this.inFlightToolCalls--;
  }
}

// Pass the Node request body to the SDK as a stream. The gateway's socket
// byte limit still applies, and the signal reports client disconnects.
function toWebRequest(req: IncomingMessage, body: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(new URL(req.url ?? '/', 'http://localhost'), {
    method: req.method ?? 'POST',
    headers,
    body,
    signal,
  });
}

/**
 * Let the SDK validate requests with `Mcp-Method` or a modern version header;
 * malformed headers and `_meta` may require an HTTP 400 response
 */
function isModernRequest(req: IncomingMessage): boolean {
  if (req.headers['mcp-method'] !== undefined) return true;
  const version = req.headers['mcp-protocol-version'];
  // ISO revision dates sort lexically.
  return typeof version === 'string' && version >= MCP_MODERN_PROTOCOL_REVISION;
}

// Undefined for a body that is not JSON; the SDK answers that with -32700
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// Give malformed tool calls without modern headers a short -32602 response
function malformedToolCall(message: unknown): { id: string | number; message: string } | undefined {
  if (!isRecord(message) || message['method'] !== 'tools/call') return undefined;
  const id = message['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  const params = message['params'];
  let problem: string | undefined;
  if (!isRecord(params)) problem = 'params must be an object';
  else if (typeof params['name'] !== 'string') problem = '"name" must be a string';
  else if (params['arguments'] !== undefined && !isRecord(params['arguments'])) {
    problem = '"arguments" must be an object';
  } else if (params['_meta'] !== undefined && !isRecord(params['_meta'])) {
    problem = '"_meta" must be an object';
  }
  return problem === undefined
    ? undefined
    : { id, message: `Invalid tools/call params: ${problem}.` };
}

// Stream the SDK's response body, including SSE, to the Node response
async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body !== null) {
    for await (const chunk of response.body) {
      if (res.destroyed) break;
      res.write(chunk);
    }
  }
  res.end();
}

// Read a proof from the selected rail's MCP `_meta` carrier
function paymentFromMeta(
  meta: Record<string, unknown> | undefined,
  resource: CommerceResource,
): PaymentSubmission | undefined {
  const method = resource.paymentMethods[0];
  if (method === 'x402') {
    const payload = x402McpPaymentSubmission(meta?.[X402_MCP_PAYMENT_META_KEY]);
    if (payload !== undefined) return { method, payload };
  }
  const credential = meta?.[MPP_MCP_CREDENTIAL_META_KEY];
  if (method === 'mpp' && isRecord(credential)) {
    // The MPP provider converts this object to an Authorization value
    return { method, payload: JSON.stringify(credential) };
  }
  return undefined;
}

export function createMcpAdapter(options?: McpAdapterOptions): HttpProtocolAdapter {
  return new McpProtocolAdapter(options);
}
