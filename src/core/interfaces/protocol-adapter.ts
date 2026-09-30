/**
 * Protocol adapter boundary. FROZEN CONTRACT.
 *
 * An adapter translates a protocol's wire format into a `CanonicalRequest`,
 * hands it to the execution pipeline and maps the outcome back. It must not
 * call merchant backends, implement payment logic or hold its own copy of the
 * canonical model. A failure while starting or serving one adapter must not
 * stop the others.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdapterDescriptor, AdapterHealth, ProtocolName } from '../domain/common';
import type { EventSink } from '../domain/event';
import type { ExecutionPipeline } from '../domain/request';
import type { ResourceRegistry } from '../domain/resource';
import type { Logger } from './logger';
import type { Clock, IdGenerator } from './runtime';

/** Everything an adapter is given. Nothing else is available to it */
export interface ProtocolAdapterContext {
  readonly pipeline: ExecutionPipeline;
  readonly resources: ResourceRegistry;
  readonly events: EventSink;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Externally reachable base URL of the gateway, from config */
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
 * A protocol adapter served over HTTP. The gateway mounts `handleHttp` at
 * `mountPath` with raw Node request and response objects, so adapters stay
 * independent of the HTTP framework.
 *
 * Guarantee: `req` arrives with its body stream unread. The gateway suppresses
 * every body parser on the mount, so an adapter whose SDK reads the body itself
 * (MCP's Streamable HTTP transport) can do so. The adapter owns reading,
 * size-limiting beyond the gateway's own cap, and parsing.
 *
 * The guarantee can break silently. Fastify prefers its exact-match
 * `application/json` and `text/plain` parsers over a `'*'` wildcard, so a
 * wildcard no-op alone lets the JSON parser drain the body and the adapter
 * reads an empty stream. The MCP conformance suite drives `handleHttp` over a
 * bare `node:http` server and cannot catch it, so any change to adapter mounting
 * needs a test that POSTs a JSON body through the real gateway and asserts the
 * adapter received it intact.
 */
export interface HttpProtocolAdapter extends ProtocolAdapter {
  /** Path prefix the gateway mounts this adapter at, e.g. '/mcp' */
  readonly mountPath: string;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * Fixed paths this adapter owns outside its mount, for protocols whose
   * specification pins a discovery URL (A2A's `/.well-known/agent-card.json`).
   * The gateway mounts them with the same guarantees as `mountPath`: unread
   * body, concurrency cap and failure isolation.
   */
  readonly additionalHttpRoutes?: readonly AdapterHttpRoute[];
}

/**
 * One fixed, method-scoped route owned by an adapter. Unlike `mountPath` it
 * registers no wildcard and matches exactly the path given.
 */
export interface AdapterHttpRoute {
  readonly method: 'GET' | 'POST';
  /** Absolute gateway path, e.g. '/.well-known/agent-card.json' */
  readonly path: string;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function isHttpProtocolAdapter(adapter: ProtocolAdapter): adapter is HttpProtocolAdapter {
  return typeof (adapter as HttpProtocolAdapter).handleHttp === 'function';
}
