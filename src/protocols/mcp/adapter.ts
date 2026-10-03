/**
 * MCP protocol adapter.
 *
 * One MCP tool per mcp-exposed canonical resource. Every `tools/call` builds a
 * `CanonicalRequest` and goes through `context.pipeline.execute()`; this file
 * never calls a merchant backend and never inspects a payment object.
 *
 * Transport: Streamable HTTP in stateless mode (no `sessionIdGenerator`). A
 * fresh low-level `Server` and `StreamableHTTPServerTransport` pair is created
 * per HTTP request and torn down when the response closes, the pattern of the
 * SDK's `examples/server/simpleStatelessStreamableHttp.js`, so no session
 * state outlives a request.
 *
 * Tools are registered on the low-level `Server`, not through
 * `McpServer.registerTool`, whose `inputSchema` accepts only a Zod schema or
 * shape. `CommerceResource.inputSchema` and the MCP wire `Tool.inputSchema`
 * are both JSON Schema, so building `Tool` objects directly carries the schema
 * through with no lossy conversion. The SDK marks `Server` `@deprecated` but
 * still documents it for advanced cases such as this one.
 *
 * Host and Origin validation (DNS-rebinding protection) is not done here. The
 * SDK deprecates the transport's `allowedHosts`, `allowedOrigins` and
 * `enableDnsRebindingProtection` in favor of validation by the host. The
 * gateway's server-wide `onRequest` hook checks every request, `/mcp`
 * included, and `McpAdapterOptions` offers nothing to build a second
 * allowlist from. Mounted outside this gateway, the adapter has no such
 * protection, which is why `MCP_UNSUPPORTED`, published at
 * `/.well-known/agent-commerce`, lists `dns-rebinding-protection`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
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
import { X402_MCP_PAYMENT_META_KEY } from '../../payments/x402/transport';
import { PACKAGE_VERSION } from '../../version';
import { MCP_TOOL_NAME_PATTERN } from './constants';
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
 * The SDK accepts JSON-RPC batches of up to 100 messages and dispatches their
 * `tools/call` handlers without waiting for earlier calls to settle. Stateless
 * mode needs no `initialize` request. One POST can therefore start many
 * concurrent `pipeline.execute()` calls, each potentially fetching from the
 * merchant. The limit of 8 lets a few concurrent calls run without queuing.
 */
const MAX_CONCURRENT_TOOL_CALLS = 8;

/**
 * Bounds the queue behind the semaphore, per adapter instance. Without it an
 * oversized batch would queue in full and then run in full. 64 is 8x
 * MAX_CONCURRENT_TOOL_CALLS, room for a legitimate burst; calls beyond it fail
 * fast with GATEWAY_BUSY and reach no backend.
 */
const MAX_QUEUED_TOOL_CALLS = 64;

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
  private readonly activeTransports = new Set<StreamableHTTPServerTransport>();

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
      if (!this.started || !this.context) {
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
      const server = this.buildServer(abortController.signal);
      // Stateless: `sessionIdGenerator` is omitted rather than set to
      // `undefined`, as `exactOptionalPropertyTypes` requires; the SDK treats
      // both the same
      const transport = new StreamableHTTPServerTransport();
      this.activeTransports.add(transport);

      const cleanup = (): void => {
        abortController.abort();
        this.activeTransports.delete(transport);
        transport.close().catch(() => {});
        server.close().catch(() => {});
      };
      res.once('close', cleanup);

      // The transport implements `Transport`; the cast only bridges its
      // `onclose`/`onerror` typed `T | undefined`, which conflicts with a bare
      // optional `T` under `exactOptionalPropertyTypes`
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res);
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
    const transports = [...this.activeTransports];
    this.activeTransports.clear();
    await Promise.all(
      transports.map(async (transport) => {
        try {
          await transport.close();
        } catch {
          // Best effort: stop() must be idempotent and never throw
        }
      }),
    );
    this.context = undefined;
  }

  private writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      // RFC 9110 requires Allow on a 405, and this endpoint takes only POST
      ...(status === 405 ? { allow: 'POST' } : {}),
    });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  }

  private buildServer(signal: AbortSignal): Server {
    const server = new Server(
      { name: this.serverName, version: this.serverVersion },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((t) => t.tool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
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
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${resourceId}".`);
    }
    try {
      const requestId = context.ids.next('mcp');
      const fields = extractReservedInputFields(rawArgs, resource, requestId);
      const { input, authorization } = fields;
      const payment = fields.payment ?? paymentFromMeta(meta, resource);
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

// Read a proof from the selected rail's MCP carrier when `_payment` is absent
function paymentFromMeta(
  meta: Record<string, unknown> | undefined,
  resource: CommerceResource,
): PaymentSubmission | undefined {
  const method = resource.paymentMethods[0];
  const x402Payload = meta?.[X402_MCP_PAYMENT_META_KEY];
  if (method === 'x402' && isRecord(x402Payload)) {
    // Match the HTTP header's base64-encoded PaymentPayload JSON
    return { method, payload: Buffer.from(JSON.stringify(x402Payload), 'utf8').toString('base64') };
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
