/**
 * Starts protocol adapters and mounts the HTTP ones. An adapter that fails to
 * start is reported unhealthy; it never stops the server or the other adapters.
 *
 * An `HttpProtocolAdapter` reads `request.raw` itself (MCP's Streamable HTTP
 * transport does), so its mount registers no-op content-type parsers, hands
 * the adapter the raw Node req/res, and calls `reply.hijack()` so Fastify
 * sends no second response.
 *
 * Fastify enforces `bodyLimit` inside the content-type parser, so a no-op
 * parser enforces none, and the MCP SDK's own 4 MB cap is far looser than
 * this one. The mount counts bytes on the socket's 'data' events instead and
 * destroys the connection past MOUNT_BODY_LIMIT_BYTES; `Content-Length` alone
 * would miss a chunked body. Node's HTTP parser already keeps the socket
 * flowing, so the extra listener only observes bytes and never takes one the
 * adapter needs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type AdapterHealth,
  type Clock,
  CommerceError,
  type HttpProtocolAdapter,
  isHttpProtocolAdapter,
  type Logger,
  type ProtocolAdapter,
  type ProtocolAdapterContext,
  toErrorEnvelope,
} from '../core';

/**
 * Body cap for adapter mounts, also used by `server.ts` as Fastify's
 * `bodyLimit`, so both surfaces enforce one number. MCP tool payloads could
 * justify more, but a whole JSON-RPC batch is parsed in memory, and this cap
 * bounds that spike.
 */
export const MOUNT_BODY_LIMIT_BYTES = 256 * 1024;

export interface AdapterRuntime {
  readonly adapter: ProtocolAdapter;
  /** Set only when `start()` threw; a failed adapter is never re-queried live */
  readonly startFailure?: AdapterHealth;
}

export interface StartAndMountOptions {
  readonly server: FastifyInstance;
  readonly adapters: readonly ProtocolAdapter[];
  readonly context: ProtocolAdapterContext;
  readonly logger: Logger;
  readonly clock: Clock;
}

export async function startAndMountAdapters(
  options: StartAndMountOptions,
): Promise<AdapterRuntime[]> {
  // Checked before any adapter starts: a path claimed twice is a composition
  // bug, and Fastify would only report it at `server.ready()` as an
  // FST_ERR_DUPLICATED_ROUTE naming neither adapter
  assertNoRouteConflicts(options.adapters);

  const runtimes: AdapterRuntime[] = [];

  for (const adapter of options.adapters) {
    // Every log line the adapter writes carries `adapter: <name>`
    const adapterLogger = options.logger.child({ adapter: adapter.name });
    const adapterContext: ProtocolAdapterContext = { ...options.context, logger: adapterLogger };

    try {
      await adapter.start(adapterContext);
    } catch (error) {
      const detail = errorMessage(error);
      adapterLogger.error(
        { err: detail },
        'Protocol adapter failed to start; gateway continues without it',
      );
      runtimes.push({
        adapter,
        startFailure: { status: 'fail', detail, checkedAt: options.clock.nowIso() },
      });
      continue;
    }

    if (isHttpProtocolAdapter(adapter)) {
      mountHttpAdapter(options.server, adapter, adapterLogger);
    }
    runtimes.push({ adapter });
  }

  return runtimes;
}

interface RouteClaim {
  readonly adapter: string;
  readonly path: string;
  // A mount also owns everything below its path, through its `/*` wildcard
  readonly wildcard: boolean;
  readonly method: 'ALL' | 'GET' | 'POST';
}

function routeClaims(adapters: readonly ProtocolAdapter[]): RouteClaim[] {
  const claims: RouteClaim[] = [];
  for (const adapter of adapters) {
    if (!isHttpProtocolAdapter(adapter)) continue;
    claims.push({
      adapter: adapter.name,
      path: adapter.mountPath.replace(/\/+$/, ''),
      wildcard: true,
      method: 'ALL',
    });
    for (const route of adapter.additionalHttpRoutes ?? []) {
      claims.push({
        adapter: adapter.name,
        path: route.path.replace(/\/+$/, ''),
        wildcard: false,
        method: route.method,
      });
    }
  }
  return claims;
}

function claimsCollide(a: RouteClaim, b: RouteClaim): boolean {
  if (a.wildcard && (b.path === a.path || b.path.startsWith(`${a.path}/`))) return true;
  if (b.wildcard && a.path.startsWith(`${b.path}/`)) return true;
  return a.path === b.path && (a.method === b.method || a.method === 'ALL' || b.method === 'ALL');
}

/**
 * Only claims from different adapters conflict. An adapter may serve a fixed
 * route under its own mount, because Fastify prefers a static route over a
 * wildcard; that is how a protocol that pins a sub-path stays self-contained.
 */
function assertNoRouteConflicts(adapters: readonly ProtocolAdapter[]): void {
  const claims = routeClaims(adapters);
  for (const [index, a] of claims.entries()) {
    for (const b of claims.slice(index + 1)) {
      if (a.adapter === b.adapter || !claimsCollide(a, b)) continue;
      throw new CommerceError(
        'CONFIG_INVALID',
        `Protocol adapters "${a.adapter}" and "${b.adapter}" both claim the HTTP path "${b.path}"; each adapter path must be served by exactly one adapter`,
        { details: { adapters: [a.adapter, b.adapter], path: b.path } },
      );
    }
  }
}

/**
 * Requests one adapter may handle at once. The body cap bounds a single
 * request, while the MCP tool-call cap applies after the SDK parses its body.
 * This limit rejects excess requests before those parses can run together.
 * Measured on Node 24: 20 concurrent 256 KiB `tools/call` batches raised RSS
 * from about 135 MB to 470 MB, and the heap returned to its idle size after GC.
 */
export const MOUNT_MAX_CONCURRENT_REQUESTS = 20;
// Ask clients to retry shortly after load shedding
const MOUNT_BUSY_RETRY_AFTER_SECONDS = 1;

function mountHttpAdapter(
  server: FastifyInstance,
  adapter: HttpProtocolAdapter,
  logger: Logger,
): void {
  const mountPath = adapter.mountPath;
  const wildcard = mountPath.endsWith('/') ? `${mountPath}*` : `${mountPath}/*`;
  const additionalRoutes = adapter.additionalHttpRoutes ?? [];
  // One counter per adapter, shared by the mount and its fixed routes, so a
  // second route into the same adapter is not a way around the cap
  let inFlight = 0;

  void server.register(async (instance) => {
    // Fastify's built-in application/json and text/plain parsers take
    // precedence over '*'. Without exact no-ops here, the JSON parser would
    // drain request.raw and the adapter's transport would read an empty stream.
    instance.addContentTypeParser(
      ['application/json', 'text/plain'],
      (_request, _payload, done) => {
        done(null);
      },
    );
    instance.addContentTypeParser('*', (_request, _payload, done) => {
      done(null);
    });

    const makeHandler =
      (handleHttp: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        if (inFlight >= MOUNT_MAX_CONCURRENT_REQUESTS) {
          // Rejected before a byte of the body is read, so no parse starts
          const error = new CommerceError(
            'GATEWAY_BUSY',
            'Too many requests already parsing on this mount; retry shortly.',
          );
          reply
            .status(error.httpStatus)
            .header('retry-after', String(MOUNT_BUSY_RETRY_AFTER_SECONDS))
            .send(toErrorEnvelope(error));
          return;
        }
        inFlight += 1;
        try {
          const stopEnforcing = enforceMountBodyLimit(
            request.raw,
            reply.raw,
            MOUNT_BODY_LIMIT_BYTES,
            logger,
          );
          try {
            await handleHttp(request.raw, reply.raw);
          } catch (error) {
            logger.error({ err: errorMessage(error) }, 'Protocol adapter request handler threw');
            if (!reply.raw.headersSent) {
              reply.raw.statusCode = 500;
              reply.raw.end();
            }
          }
          stopEnforcing();
          reply.hijack();
        } finally {
          // Always released: a stranded count shrinks the cap for good and
          // eventually refuses every request on this mount
          inFlight -= 1;
        }
      };

    const mountHandler = makeHandler((req, res) => adapter.handleHttp(req, res));
    instance.all(mountPath, mountHandler);
    instance.all(wildcard, mountHandler);

    for (const route of additionalRoutes) {
      instance.route({
        method: route.method,
        url: route.path,
        handler: makeHandler((req, res) => route.handleHttp(req, res)),
      });
    }
  });
}

function enforceMountBodyLimit(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  logger: Logger,
): () => void {
  const socket = req.socket;
  let total = 0;
  let stopped = false;
  const onData = (chunk: Buffer): void => {
    total += chunk.length;
    if (total > maxBytes) {
      stop();
      logger.warn({ maxBytes }, 'Request body exceeded the mount body limit; connection closed');
      // A bare destroy gives a legitimate client an ECONNRESET that never
      // names the cap, so try a 413 with a JSON-RPC error first. If the
      // adapter already started its own response, just destroy. The rest of
      // the oversized body is never read.
      if (!res.headersSent) {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: `Request body exceeds the ${maxBytes}-byte mount limit` },
        });
        try {
          res.writeHead(413, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          });
          // The callback fires once the write reaches the OS, not the peer,
          // so the destroy can still truncate the 413 into an ECONNRESET.
          // Accepted: leaving the read side open would let the oversized
          // body keep flowing to whatever reads `req`.
          res.end(body, () => socket.destroy());
          return;
        } catch {
          // The socket may already be gone; fall through to a bare destroy
        }
      }
      socket.destroy();
    }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    // A keep-alive socket serves many requests and each adds both listeners.
    // Leaving the 'close' ones behind piles them up until MaxListenersExceeded.
    socket.removeListener('data', onData);
    socket.removeListener('close', stop);
  };
  socket.on('data', onData);
  socket.once('close', stop);
  return stop;
}

export async function getAdapterHealth(
  runtime: AdapterRuntime,
  clock: Clock,
): Promise<AdapterHealth> {
  if (runtime.startFailure) return runtime.startFailure;
  try {
    return await runtime.adapter.health();
  } catch (error) {
    return { status: 'fail', detail: errorMessage(error), checkedAt: clock.nowIso() };
  }
}

export async function stopAdapters(
  runtimes: readonly AdapterRuntime[],
  logger: Logger,
): Promise<void> {
  for (const runtime of runtimes) {
    try {
      await runtime.adapter.stop();
    } catch (error) {
      logger
        .child({ adapter: runtime.adapter.name })
        .error({ err: errorMessage(error) }, 'Protocol adapter failed to stop cleanly');
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
