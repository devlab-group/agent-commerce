/**
 * Adapter isolation: a failing adapter must not
 * prevent the server from starting or other adapters from working.
 *
 * `HttpProtocolAdapter`s are mounted at `adapter.mountPath` inside an
 * encapsulated Fastify plugin that never lets Fastify consume the request
 * body — the adapter's own transport (MCP's Streamable HTTP) reads
 * `request.raw` itself, so we register a wildcard content-type parser that
 * is a deliberate no-op, then hand the adapter the raw Node req/res and
 * `reply.hijack()` so Fastify does not also try to send a response.
 *
 * Fastify enforces `bodyLimit` *inside* the content-type parser — a
 * parser that never touches the payload never enforces it, so this mount had
 * no body cap at all, and the SDK's Streamable HTTP transport buffers the
 * whole request into memory with no cap of its own (unauthenticated, no
 * handshake needed). MOUNT_BODY_LIMIT_BYTES is enforced by tallying bytes on
 * the underlying *socket* (not the request stream) as they arrive and
 * destroying the connection past the cap: `Content-Length` alone is
 * insufficient (chunked encoding has none), and observing the socket's own
 * 'data' event doesn't compete with however the adapter reads the body —
 * Node's HTTP module already keeps the socket flowing internally to feed its
 * parser, so an extra listener is pure fan-out, never a second consumer. It
 * can only ever say "stop", never corrupt or steal a byte the adapter needs.
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
} from '../core/index.js';

/**
 * A separate, larger (1 MB) cap for this mount is tempting — MCP tool
 * payloads can legitimately carry more data than a REST-style invoke body.
 * It matches `server.ts`'s route `bodyLimit` (256 KB) anyway: the adapter
 * closes the batch-fan-out half (bounded concurrency, stop-on-disconnect),
 * but the SDK transport still parses the whole array before adapter code
 * ever runs, so
 * this cap is the only lever left on the first-request parse-time memory
 * spike, and a smaller cap admits proportionally fewer batch entries. One
 * documented number is also simpler to state correctly than "two caps,
 * enforced two different ways" — which is how `/mcp` ended up with no cap
 * at all in the first place (see docs/security.md). `server.ts` imports
 * this rather than defining its own, so there is exactly one number, not
 * two that happen to currently agree.
 */
export const MOUNT_BODY_LIMIT_BYTES = 256 * 1024;

export interface AdapterRuntime {
  readonly adapter: ProtocolAdapter;
  /** Set only when `start()` threw; a failed adapter is never re-queried live. */
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
  // Before anything starts: two adapters claiming the same path is a
  // composition-root bug, not a runtime condition. Fastify would only notice
  // it inside deferred route registration and fail `server.ready()` with an
  // opaque FST_ERR_DUPLICATED_ROUTE naming neither adapter.
  assertNoRouteConflicts(options.adapters);

  const runtimes: AdapterRuntime[] = [];

  for (const adapter of options.adapters) {
    // Pre-scope the logger so every adapter's own log calls carry
    // `adapter: <name>` automatically — the adapter never has to remember to
    // add it itself.
    const adapterLogger = options.logger.child({ adapter: adapter.name });
    const adapterContext: ProtocolAdapterContext = { ...options.context, logger: adapterLogger };

    try {
      await adapter.start(adapterContext);
    } catch (error) {
      const detail = describeError(error);
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
  /** A mount also owns everything below its path, through its `/*` wildcard. */
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
 * Only *cross-adapter* claims conflict. An adapter serving a fixed route under
 * its own mount is fine — Fastify prefers a static route over a wildcard — and
 * is how a protocol that pins a sub-path stays self-contained.
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
 * The body limit and the per-tool-call semaphore
 * (`protocol-mcp`'s MAX_CONCURRENT_TOOL_CALLS) both bound *what happens
 * after* a request is parsed — neither sees the SDK's own JSON.parse of the
 * request body, which was measured spiking one 256 KB batch
 * request's heap by ~106 MB (26 -> 132 MB) before GC reclaims it. Not a
 * leak, but unbounded concurrency times an unbounded spike is unbounded
 * memory: a 20-concurrent-batches probe (262 KB each) is
 * the only concurrency level this has actually been measured safe at (peak
 * RSS 368 MB, fully reclaimed) — so 20 is the cap, not a rounder guess.
 * compose sets no memory limit, so this is the only thing standing between
 * "~40 connections" and a multi-gigabyte spike.
 */
export const MOUNT_MAX_CONCURRENT_REQUESTS = 20;
/** Short and blunt on purpose: this is a parse-time spike that clears in
 * well under a second once GC runs, not an outage a client should back off
 * from for long. */
const MOUNT_BUSY_RETRY_AFTER_SECONDS = 1;

function mountHttpAdapter(
  server: FastifyInstance,
  adapter: HttpProtocolAdapter,
  logger: Logger,
): void {
  const mountPath = adapter.mountPath;
  const wildcard = mountPath.endsWith('/') ? `${mountPath}*` : `${mountPath}/*`;
  const additionalRoutes = adapter.additionalHttpRoutes ?? [];
  // One counter for the whole adapter, mount and fixed routes alike: the cap
  // bounds what this adapter can be made to parse concurrently, and a second
  // door into the same adapter would be a way around it.
  let inFlight = 0;

  void server.register(async (instance) => {
    // Fastify pre-registers exact-match parsers for application/json and
    // text/plain that run BEFORE the '*' fallback (checked in getParser()).
    // MCP clients send application/json, so without an exact no-op here
    // Fastify's built-in JSON parser drains request.raw before the adapter's
    // own transport ever reads it -> the adapter sees an empty stream.
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
          // Reject before the SDK ever sees the body — the whole point is to
          // never let a request past this line start the parse that spikes
          // memory. No body-limit enforcement needed either: nothing here has
          // read a byte of it yet.
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
            logger.error({ err: describeError(error) }, 'Protocol adapter request handler threw');
            if (!reply.raw.headersSent) {
              reply.raw.statusCode = 500;
              reply.raw.end();
            }
          }
          stopEnforcing();
          reply.hijack();
        } finally {
          // Always released, even on a throw above — a stranded count would
          // shrink the effective cap by one forever and eventually 503 every
          // request on this mount permanently, which is worse than the
          // problem this exists to solve.
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
      // a bare socket.destroy() gives the client ECONNRESET
      // with nothing naming the cap — right for an attacker, wrong for a
      // legitimate client the first time a tool payload crosses the limit.
      // Attempt a 413 with a JSON-RPC error body first, then destroy once it
      // has actually flushed. If the adapter already started writing its own
      // response, headersSent is true and there is nothing left to say —
      // just destroy. Never read the rest of the oversized body to be polite
      // about it; that defeats the point of the cap.
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
          // `.end()`'s callback fires once the write is handed to the OS,
          // not once the peer has actually received it, so even a
          // best-effort destroy afterward can occasionally race a
          // still-in-flight response and truncate it (the client sees a
          // bare ECONNRESET instead of the 413 body). That is an accepted
          // trade — see "attempt" in the comment above — over leaving the
          // read side open, which would undo the whole point of this cap
          // (an attacker's still-arriving bytes must not keep flowing to
          // whatever is reading `req`).
          res.end(body, () => socket.destroy());
          return;
        } catch {
          // Fall through to a bare destroy below — e.g. the socket was
          // already gone by the time we tried to write.
        }
      }
      socket.destroy();
    }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    // A keep-alive connection carries many requests, and this function adds
    // a 'close' listener per request. Removing only the 'data' listener here
    // would leave the 'close' one to pile up, one per request, until the
    // connection finally closed (MaxListenersExceeded at request 11). Remove
    // both.
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
    return { status: 'fail', detail: describeError(error), checkedAt: clock.nowIso() };
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
        .error({ err: describeError(error) }, 'Protocol adapter failed to stop cleanly');
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
