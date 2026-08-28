/**
 * Protocol adapter boundary.
 *
 * FROZEN CONTRACT. An adapter translates a protocol's wire format into a
 * `CanonicalRequest`, hands it to the execution pipeline and maps the outcome
 * back. It must not call merchant backends, implement payment logic, or hold
 * its own copy of the canonical model.
 *
 * Adapter isolation: a failure while starting or serving one adapter must not
 * prevent the others from operating.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdapterDescriptor, AdapterHealth, ProtocolName } from '../domain/common.js';
import type { EventSink } from '../domain/event.js';
import type { ExecutionPipeline } from '../domain/request.js';
import type { ResourceRegistry } from '../domain/resource.js';
import type { Logger } from './logger.js';
import type { Clock, IdGenerator } from './runtime.js';

/** Everything an adapter is given. Nothing else is available to it. */
export interface ProtocolAdapterContext {
  readonly pipeline: ExecutionPipeline;
  readonly resources: ResourceRegistry;
  readonly events: EventSink;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Externally reachable base URL of the gateway, from config. */
  readonly publicBaseUrl: string;
}

export interface ProtocolAdapter {
  readonly name: ProtocolName;
  readonly descriptor: AdapterDescriptor;

  start(context: ProtocolAdapterContext): Promise<void>;
  health(): Promise<AdapterHealth>;
  stop(): Promise<void>;
}

/**
 * A protocol adapter served over HTTP.
 *
 * The gateway mounts `handleHttp` at `mountPath` using raw Node request and
 * response objects, so adapters stay independent of the HTTP framework.
 *
 * GUARANTEE — the request body is **unconsumed**.
 *
 * `req` is handed over with its stream unread: the gateway suppresses every
 * body parser on this mount, so an adapter whose SDK reads the body itself
 * (MCP's Streamable HTTP transport does) can do so. The adapter owns reading,
 * size-limiting beyond the gateway's own cap, and parsing.
 *
 * This is load-bearing and easy to break silently. Fastify pre-registers
 * exact-match parsers for `application/json` and `text/plain` and prefers them
 * over a `'*'` wildcard, so registering only a wildcard no-op leaves the
 * built-in JSON parser draining the body first — the adapter then reads an
 * empty stream and every request fails to parse. That exact regression shipped
 * once and no unit test caught it, because adapter conformance suites drive
 * `handleHttp` over a bare `node:http` server and never traverse the gateway.
 *
 * Any change to how adapters are mounted must be covered by a test that POSTs
 * a real JSON body through the real gateway and asserts the adapter received
 * it intact.
 */
export interface HttpProtocolAdapter extends ProtocolAdapter {
  /** Path prefix the gateway mounts this adapter at, e.g. '/mcp'. */
  readonly mountPath: string;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * Fixed paths this adapter owns *outside* its mount, for protocols whose
   * specification pins a discovery URL (A2A's `/.well-known/agent-card.json`).
   * The gateway mounts them with the same guarantees as `mountPath` — same
   * unconsumed body, same concurrency cap, same failure isolation — so the
   * gateway needs no per-protocol routing knowledge.
   *
   * Omitted by adapters that need none.
   */
  readonly additionalHttpRoutes?: readonly AdapterHttpRoute[];
}

/**
 * One fixed, method-scoped route owned by an adapter. Unlike `mountPath` it
 * registers no wildcard: it matches exactly the path given.
 */
export interface AdapterHttpRoute {
  readonly method: 'GET' | 'POST';
  /** Absolute gateway path, e.g. '/.well-known/agent-card.json'. */
  readonly path: string;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function isHttpProtocolAdapter(adapter: ProtocolAdapter): adapter is HttpProtocolAdapter {
  return typeof (adapter as HttpProtocolAdapter).handleHttp === 'function';
}
