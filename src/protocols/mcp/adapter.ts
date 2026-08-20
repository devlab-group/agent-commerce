/**
 * MCP protocol adapter.
 *
 * One MCP tool per canonical resource exposed via `exposedVia: ['mcp']`.
 * Every `tools/call` builds a `CanonicalRequest` and goes through
 * `context.pipeline.execute()` — this file never calls a merchant backend and
 * never inspects a payment object, it only surfaces what the pipeline
 * returns.
 *
 * Transport: Streamable HTTP, **stateless** mode (no `sessionIdGenerator`,
 * i.e. session id generation left undefined). A fresh low-level `Server` +
 * `StreamableHTTPServerTransport` pair is created per HTTP request and torn
 * down when the response closes —
 * this is the pattern @modelcontextprotocol/sdk@1.30.0's own
 * `examples/server/simpleStatelessStreamableHttp.js` uses, and it avoids
 * holding cross-request session state the gateway has no lifecycle hook for.
 *
 * Tool registration uses the low-level `Server` (`setRequestHandler` for
 * `ListToolsRequestSchema` / `CallToolRequestSchema`) rather than the
 * higher-level `McpServer.registerTool`. `McpServer.registerTool`'s
 * `inputSchema` only accepts a Zod schema or a raw Zod shape
 * (`server/zod-compat.d.ts`: `AnySchema = z3.ZodTypeAny | z4.$ZodType`) — it
 * does not accept a raw JSON Schema object. The canonical
 * `CommerceResource.inputSchema` is already JSON Schema, and the MCP wire
 * format for `Tool.inputSchema` *is* JSON Schema, so building `Tool` objects
 * directly (via the low-level `Server`) carries it through verbatim with no
 * lossy JSON-Schema-to-Zod conversion. `Server` is marked `@deprecated` in
 * favour of `McpServer`'s ergonomics, but remains fully supported — its
 * documented use is exactly this kind of advanced, non-Zod case.
 *
 * Origin/Host validation (DNS-rebinding protection): deliberately NOT done
 * here. `StreamableHTTPServerTransport` is constructed with no
 * `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` — all three
 * are `@deprecated` in the pinned SDK's own
 * `webStandardStreamableHttp.d.ts`, in favour of exactly the fix applied
 * here: an allowlist enforced by the *host* before a request ever reaches an
 * adapter. `src/gateway`'s `onRequest` hook is that enforcement point —
 * it covers `/mcp` and the HTTP routes together, so there is one allowlist
 * for the whole gateway instead of one per adapter. This adapter has no
 * config surface to build a second one from: `McpAdapterOptions` is frozen
 * (docs/contracts.md) to `{ mountPath?, serverName?, serverVersion? }`, and
 * the only signal available without a contract change —
 * `context.publicBaseUrl` — is one string that may not match what a
 * reverse-proxied deployment's `Host`/`Origin` headers actually carry. A
 * second, narrower allowlist built from it would not add coverage the
 * gateway's hook doesn't already provide; it would only add a second place
 * that can reject legitimate traffic the gateway just allowed, for a
 * deprecated code path upstream is steering consumers away from. Revisit
 * this if the adapter is ever meant to be mounted somewhere other than this
 * gateway. See `descriptor.unsupported` — this reliance on the host is
 * recorded there too, not just here, so `doctor`/`.well-known` surface it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type CanonicalRequest,
  CommerceError,
  type CommerceResource,
  type HttpProtocolAdapter,
  type ProtocolAdapterContext,
  toCommerceError,
} from '../../core/index.js';
import { buildDescriptor, PACKAGE_VERSION } from './descriptor.js';
import { errorResult, extractPaymentSubmission, mapOutcome } from './result-mapping.js';
import {
  buildInputSchema,
  buildToolDescription,
  isValidToolName,
  MCP_TOOL_NAME_PATTERN,
} from './tool-mapping.js';

export interface McpAdapterOptions {
  /** Path prefix the gateway mounts this adapter at. Default '/mcp'. */
  readonly mountPath?: string;
  /** MCP `Implementation.name` reported during initialize. */
  readonly serverName?: string;
  /** MCP `Implementation.version` reported during initialize. Default: this package's version. */
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
 * The pinned MCP SDK's Streamable HTTP transport
 * accepts a JSON-RPC **batch** (a bare array in the POST body) and dispatches
 * every element to this adapter's `tools/call` handler in one synchronous
 * `for` loop with no `await` between iterations and no cap on the array's
 * length (`webStandardStreamableHttp.js`'s `handlePostRequest`, via
 * `shared/protocol.js`'s `_onrequest`, which fires the handler and returns
 * without waiting for it to settle). Nothing between the transport and this
 * adapter enforces stateless mode's own precondition that `tools/call`
 * requires no prior `initialize` — so one POST, no handshake, N `tools/call`
 * messages, is a legal request that becomes N concurrent
 * `context.pipeline.execute()` calls, each of which may end in a live
 * `fetch()` to the merchant's backend. 8 keeps a handful of genuinely
 * concurrent tool calls (the common case for an agent working a multi-step
 * task) from ever queuing, while still bounding the worst case to a small,
 * fixed number of simultaneous outbound connections regardless of how large
 * a batch a caller sends. The worst case measured without it was 5000
 * concurrent backend calls from a single request.
 */
const MAX_CONCURRENT_TOOL_CALLS = 8;

/**
 * The semaphore above bounds concurrency but not
 * queue depth — `acquireToolCallSlot` pushed one resolver per waiting call
 * onto `toolCallWaiters` with no ceiling, so an oversized batch (thousands
 * of `tools/call` messages, still well under the gateway's own 1 MB body
 * cap) queued in full and then *ran* in full, including the ~30 seconds
 * after the client had already disconnected. 64 is 8x
 * MAX_CONCURRENT_TOOL_CALLS: enough that a legitimate short burst from one
 * agent never gets rejected (the measured honest case tops out at a
 * handful of concurrent calls), while capping the adapter's total
 * exposure — in flight plus queued — to a small, fixed number of real
 * `pipeline.execute()` calls no matter how large a batch a caller sends.
 * Calls beyond the queue fail fast with no backend call at all, rather
 * than piling up behind it.
 *
 * Scope note: this cap is per `McpProtocolAdapter` instance.
 * The gateway's own SSE-subscriber cap is per gateway instance. Both
 * happen to be one-per-process today, so the two read the same in
 * practice — but they are not the same scope, and that stops being true
 * the moment either one is ever instantiated more than once per process.
 */
const MAX_QUEUED_TOOL_CALLS = 64;

export class McpProtocolAdapter implements HttpProtocolAdapter {
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

  // Counting semaphore bounding concurrent `context.pipeline.execute()`
  // calls. Lives on the adapter instance (one per gateway mount, for the
  // process lifetime), not per-request, so the cap holds across concurrent
  // `/mcp` requests too — not just within one oversized batch. A request
  // only ever waits here once MAX_CONCURRENT_TOOL_CALLS executions are
  // already in flight adapter-wide, which is the throttle working as
  // intended, not two unrelated single-call requests blocking each other.
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
        { adapter: 'mcp', err: toCommerceError(err).toInfo() },
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

      // one AbortController per HTTP request, aborted
      // from the same `res` 'close' handler that already tears down the
      // transport/server pair. `handleToolCall` checks this after acquiring
      // its concurrency slot — never mid-`pipeline.execute()`, since a call
      // that already reached settlement must be allowed to finish (aborting
      // there is worse than finishing: the buyer may already be charged).
      const abortController = new AbortController();
      const server = this.buildServer(abortController.signal);
      // Stateless mode: omitting `sessionIdGenerator` (rather than setting it
      // to `undefined`) is required under `exactOptionalPropertyTypes`, and
      // has identical runtime behaviour — see
      // dist/esm/server/webStandardStreamableHttp.js: session handling is
      // gated on `!this.sessionIdGenerator`, true either way.
      const transport = new StreamableHTTPServerTransport();
      this.activeTransports.add(transport);

      const cleanup = (): void => {
        abortController.abort();
        this.activeTransports.delete(transport);
        transport.close().catch(() => {});
        server.close().catch(() => {});
      };
      res.once('close', cleanup);

      // `StreamableHTTPServerTransport implements Transport` per the SDK's
      // own declaration; the cast works around its `onclose`/`onerror`
      // accessors being typed `T | undefined` where `Transport` declares a
      // bare optional `T`, which only conflicts under this project's
      // `exactOptionalPropertyTypes`.
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      this.context?.logger.error(
        { adapter: 'mcp', err: toCommerceError(err).toInfo() },
        'mcp adapter: request handling failed',
      );
      this.writeJsonRpcError(res, 500, 'Internal server error.');
    }
  }

  async health(): Promise<AdapterHealth> {
    const checkedAt = this.context?.clock.nowIso() ?? new Date().toISOString();
    try {
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
    } catch (err) {
      return {
        status: 'fail',
        detail: `mcp adapter health check failed: ${toCommerceError(err).message}`,
        checkedAt,
      };
    }
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
          // best-effort cleanup — stop() must be idempotent and never throw.
        }
      }),
    );
    this.context = undefined;
  }

  private writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
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
      this.handleToolCall(request.params.name, request.params.arguments ?? {}, signal),
    );
    return server;
  }

  private async handleToolCall(
    resourceId: string,
    rawArgs: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const context = this.context;
    if (!context) {
      return errorResult(new CommerceError('INTERNAL_ERROR', 'MCP adapter is not running.'));
    }
    try {
      // Defence in depth: `tools/list` only ever advertises mcp-exposed,
      // legal-name resources, but a client can still send `tools/call` for
      // any name. Gate here too (core also enforces exposedVia in the
      // pipeline) — do not rely on core alone. Message stays identical to a
      // genuinely unknown id so we never reveal that a resource exists but
      // is scoped to another protocol.
      const resource = this.toolsByResourceId.get(resourceId);
      if (!resource) {
        return errorResult(
          new CommerceError('RESOURCE_NOT_FOUND', `Unknown tool "${resourceId}".`, { resourceId }),
        );
      }
      const { input, payment } = extractPaymentSubmission(rawArgs, resource);
      const request: CanonicalRequest = {
        requestId: context.ids.next('mcp'),
        resourceId,
        input,
        protocol: 'mcp',
        receivedAt: context.clock.nowIso(),
        ...(payment !== undefined ? { payment } : {}),
      };
      await this.acquireToolCallSlot(signal);
      try {
        // the only cancellation point. A call queued
        // behind a full semaphore, whose caller has since disconnected,
        // must not start a fresh pipeline.execute() (and possibly a live
        // merchant-backend fetch) — that is the "runs for 30s after the
        // client left" bug. Checked here and nowhere else: once execute()
        // is called it may reach settle(), and an in-flight payment must be
        // allowed to finish rather than be abandoned mid-flight.
        if (signal.aborted) {
          // deliberately *not* GATEWAY_BUSY. That code
          // means "transient, back off and retry" — true for the queue-full
          // case below, false here: there is no caller left to retry, so
          // telling one to would be meaningless. PROTOCOL_UNSUPPORTED is the
          // least dishonest fit among the frozen codes (non-retryable, which
          // is the one property that matters for a response nobody reads),
          // not a precise description of "the caller went away" — none of
          // the frozen codes names that condition. Left flagged as a known
          // gap rather than reused past what it's honestly for.
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
        // Always release, even if execute() throws — a stranded permit
        // would shrink MAX_CONCURRENT_TOOL_CALLS by one forever and
        // eventually deadlock the adapter, which is worse.
        this.releaseToolCallSlot();
      }
    } catch (err) {
      return errorResult(toCommerceError(err));
    }
  }

  /**
   * Blocks until fewer than MAX_CONCURRENT_TOOL_CALLS executions are in
   * flight, or throws if the queue behind that gate is already full or the
   * caller disconnected while waiting. Throwing
   * here never leaks a permit: `inFlightToolCalls` is only incremented on
   * the success path below, after every rejection point.
   */
  private async acquireToolCallSlot(signal: AbortSignal): Promise<void> {
    if (this.toolCallWaiters.length >= MAX_QUEUED_TOOL_CALLS) {
      // GATEWAY_BUSY, not PROTOCOL_UNSUPPORTED. This
      // is load shedding, which is transient by definition — the caller
      // should back off and retry, matching the message below. Before
      // GATEWAY_BUSY existed this threw PROTOCOL_UNSUPPORTED (HTTP 501,
      // `retryable: false`), so the envelope told an agent framework keyed
      // on the machine-readable flag that a momentary throttle was a
      // permanent capability gap — contradicting this exact message.
      throw new CommerceError(
        'GATEWAY_BUSY',
        'Too many tool calls already queued on this adapter; retry later.',
      );
    }
    // `while`, not `if`. A wake-up only means a slot
    // was *freed*, not that this waiter is now entitled to it regardless of
    // what else has happened since — re-check the same condition the loop
    // waited on rather than assume one wake-up means one free slot forever.
    // (Currently that assumption would also happen to hold, since
    // `releaseToolCallSlot` decrements before waking the next waiter and JS
    // has no thread to race it — but that is a scheduling fact about this
    // file, not something `if` states, and it is exactly the kind of thing
    // a later refactor breaks silently. `while` doesn't depend on it.)
    while (this.inFlightToolCalls >= MAX_CONCURRENT_TOOL_CALLS) {
      await new Promise<void>((resolve) => this.toolCallWaiters.push(resolve));
      if (signal.aborted) {
        // This waiter is declining the slot that was just freed for it —
        // pass it straight to the next waiter in line instead of stranding
        // everyone behind it. Without this, a disconnect partway through a
        // deep queue leaves every later waiter's promise waiting on a
        // wake-up call that only its own dedicated release() would have
        // sent — and that release never comes, because this waiter never
        // takes the slot that would have produced it.
        this.toolCallWaiters.shift()?.();
        // PROTOCOL_UNSUPPORTED, not GATEWAY_BUSY —
        // same reasoning as the other disconnect check above. Non-retryable
        // is correct here (nobody is listening to retry); "unsupported" is
        // not a precise name for "the caller left", it's just the least
        // dishonest fit among the frozen codes.
        throw new CommerceError('PROTOCOL_UNSUPPORTED', 'Client disconnected while queued.');
      }
    }
    this.inFlightToolCalls++;
  }

  private releaseToolCallSlot(): void {
    this.inFlightToolCalls--;
    // Wake the oldest waiter, if any; it will re-increment once it resumes.
    this.toolCallWaiters.shift()?.();
  }
}

export function createMcpAdapter(options?: McpAdapterOptions): HttpProtocolAdapter {
  return new McpProtocolAdapter(options ?? {});
}
