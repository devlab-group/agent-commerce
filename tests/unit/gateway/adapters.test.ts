import * as http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type {
  Clock,
  EventSink,
  ExecutionPipeline,
  HttpProtocolAdapter,
  IdGenerator,
  Logger,
  ProtocolAdapter,
  ProtocolAdapterContext,
  ResourceRegistry,
} from '../../../src/core/index.js';
import {
  type AdapterRuntime,
  getAdapterHealth,
  MOUNT_BODY_LIMIT_BYTES,
  MOUNT_MAX_CONCURRENT_REQUESTS,
  startAndMountAdapters,
  stopAdapters,
} from '../../../src/gateway/adapters.js';
import { createFakeHttpAdapter, createFakeProtocolAdapter } from './helpers.js';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

const clock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  nowIso: () => '2026-01-01T00:00:00.000Z',
  monotonicMs: () => 0,
};

function fakeContext(): ProtocolAdapterContext {
  return {
    pipeline: {
      execute: async () => {
        throw new Error('unused');
      },
    } as unknown as ExecutionPipeline,
    resources: {
      get: () => undefined,
      list: () => [],
      listExposedVia: () => [],
      has: () => false,
    } as ResourceRegistry,
    events: { emit: async () => {} } as EventSink,
    logger: NOOP_LOGGER,
    clock,
    ids: { next: () => 'id' } as IdGenerator,
    publicBaseUrl: 'http://localhost:8080',
  };
}

describe('startAndMountAdapters / adapter isolation', () => {
  it('records a start failure without throwing and without mounting routes', async () => {
    const server = Fastify({ logger: false });
    const bad = createFakeProtocolAdapter({
      name: 'http',
      start: async () => {
        throw new Error('cannot bind port');
      },
    });

    const runtimes = await startAndMountAdapters({
      server,
      adapters: [bad],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.startFailure?.status).toBe('fail');
    const health = await getAdapterHealth(runtimes[0]!, clock);
    expect(health.status).toBe('fail');
    await server.close();
  });

  it('mounts a successfully-started HttpProtocolAdapter at its mountPath', async () => {
    const server = Fastify({ logger: false });
    const adapter = createFakeHttpAdapter({ mountPath: '/mcp' });

    const runtimes = await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.ready();

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.startFailure).toBeUndefined();

    const res = await server.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('fake-adapter-response');

    const nested = await server.inject({ method: 'GET', url: '/mcp/sub/path' });
    expect(nested.statusCode).toBe(200);

    await server.close();
  });

  it('a POST with a real application/json body reaches the adapter intact (regression: Fastify must not drain it first)', async () => {
    // Cheaper localiser for the same class of bug the full MCP-over-gateway
    // integration test guards end to end: this asserts the raw request
    // stream Fastify hands the adapter still has its body unconsumed, without
    // needing a real MCP client/server round trip.
    const server = Fastify({ logger: false });
    const sentBody = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    let seenBody = '';
    const adapter = createFakeHttpAdapter({
      mountPath: '/mcp',
      handleHttp: async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        seenBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      },
    });

    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.ready();

    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: sentBody,
    });

    expect(res.statusCode).toBe(200);
    expect(seenBody).toBe(sentBody);

    await server.close();
  });

  it('destroys the connection once a CHUNKED (no Content-Length) body exceeds the mount limit', async () => {
    // A Content-Length-only test would pass while the real hole (chunked
    // transfer, which has no declared length up front) stayed open — this
    // sends a real oversized body over a real socket with no Content-Length
    // header at all, so Node's http client uses chunked transfer-encoding.
    const server = Fastify({ logger: false });
    let receivedBytes = 0;
    let handlerCompleted = false;
    const adapter = createFakeHttpAdapter({
      mountPath: '/mcp',
      handleHttp: async (req, res) => {
        try {
          for await (const chunk of req) receivedBytes += (chunk as Buffer).length;
          handlerCompleted = true;
        } catch {
          // Expected once the server destroys the socket mid-body.
        }
        if (!res.headersSent) res.writeHead(200);
        res.end();
      },
    });

    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const totalToSend = MOUNT_BODY_LIMIT_BYTES * 4; // well over the cap
    const chunkSize = 64 * 1024;
    const chunk = Buffer.alloc(chunkSize, 'x');

    const clientError = await new Promise<Error | undefined>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json' }, // no Content-Length -> chunked
      });
      let resolved = false;
      const finish = (err?: Error): void => {
        if (resolved) return;
        resolved = true;
        resolve(err);
      };
      req.on('error', (err) => finish(err));
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => finish(undefined));
      });

      let written = 0;
      const writeMore = (): void => {
        if (written >= totalToSend) {
          req.end();
          return;
        }
        written += chunkSize;
        const ok = req.write(chunk, (err) => {
          if (err) finish(err);
        });
        if (ok) setImmediate(writeMore);
        else req.once('drain', writeMore);
      };
      writeMore();
    });

    // The server must have cut the connection before the full body arrived:
    // either the client saw a socket error, or the handler never got to
    // finish reading (both are valid signals the destroy() fired in time).
    expect(clientError !== undefined || !handlerCompleted).toBe(true);
    expect(receivedBytes).toBeLessThan(totalToSend);

    await server.close();
  });

  it('sends a 413 naming the limit before destroying the connection, instead of a bare reset', async () => {
    const server = Fastify({ logger: false });
    const adapter = createFakeHttpAdapter({
      mountPath: '/mcp',
      handleHttp: async (req, res) => {
        try {
          for await (const _chunk of req) {
            // never resolves before the cap fires — draining is the point
          }
        } catch {
          // Expected once the server destroys the socket.
        }
        if (!res.headersSent) res.writeHead(200);
        res.end();
      },
    });

    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const totalToSend = MOUNT_BODY_LIMIT_BYTES * 4;
    const chunkSize = 64 * 1024;
    const chunk = Buffer.alloc(chunkSize, 'x');

    const attempt = (): Promise<{ status: number | undefined; body: string }> =>
      new Promise((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        let body = '';
        req.on('error', () => resolve({ status: undefined, body }));
        req.on('response', (res) => {
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
          res.on('error', () => resolve({ status: res.statusCode, body }));
        });

        let written = 0;
        const writeMore = (): void => {
          if (written >= totalToSend) {
            req.end();
            return;
          }
          written += chunkSize;
          const ok = req.write(chunk, () => {});
          if (ok) setImmediate(writeMore);
          else req.once('drain', writeMore);
        };
        writeMore();
      });

    // The response callback fires once the write is handed to the OS, not
    // once the peer has received it, so destroying the socket right after
    // can occasionally race a still-in-flight response and truncate it into
    // a bare client-side error instead — the same accepted trade documented
    // on the `res.end(body, () => socket.destroy())` call this exercises.
    // Retry rather than assert on a single attempt: what this test protects
    // is that the diagnostic is actually reachable, not that every single
    // request wins the race under system load.
    let result: { status: number | undefined; body: string } | undefined;
    for (let i = 0; i < 5 && result?.status !== 413; i += 1) {
      result = await attempt();
    }

    expect(result?.status).toBe(413);
    const parsed = JSON.parse(result?.body ?? '{}') as { error?: { message?: string } };
    expect(parsed.error?.message).toContain(String(MOUNT_BODY_LIMIT_BYTES));

    await server.close();
  });

  it('caps in-flight /mcp requests at MOUNT_MAX_CONCURRENT_REQUESTS, returning 503 GATEWAY_BUSY with Retry-After past it', async () => {
    const server = Fastify({ logger: false });
    let entered = 0;
    const releasers: Array<() => void> = [];
    const adapter = createFakeHttpAdapter({
      mountPath: '/mcp',
      handleHttp: async (_req, res) => {
        entered += 1;
        await new Promise<void>((resolve) => releasers.push(resolve));
        res.writeHead(200);
        res.end('{}');
      },
    });

    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });

    // Fill the cap: fire MOUNT_MAX_CONCURRENT_REQUESTS requests that all
    // block inside handleHttp until released below.
    const inFlightResponses = Array.from({ length: MOUNT_MAX_CONCURRENT_REQUESTS }, () =>
      server.inject({ method: 'POST', url: '/mcp', payload: '{}' }),
    );
    await vi.waitFor(() => expect(entered).toBe(MOUNT_MAX_CONCURRENT_REQUESTS));

    // The next one, over the cap, must be rejected immediately — it must
    // not enter handleHttp at all.
    const busy = await server.inject({ method: 'POST', url: '/mcp', payload: '{}' });
    expect(entered).toBe(MOUNT_MAX_CONCURRENT_REQUESTS);
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBeDefined();
    const body = JSON.parse(busy.body) as { code?: string; retryable?: boolean };
    expect(body.code).toBe('GATEWAY_BUSY');
    expect(body.retryable).toBe(true);

    // Release everyone and confirm they all actually completed (proves the
    // counter isn't just permanently pinned at the cap for some other
    // reason, e.g. a bug that never lets requests finish).
    for (const release of releasers) release();
    const settled = await Promise.all(inFlightResponses);
    for (const res of settled) expect(res.statusCode).toBe(200);

    await server.close();
  });

  it("does not leak a socket 'close' listener per request on a keep-alive connection", async () => {
    // Under HTTP keep-alive — the normal mode for an MCP client holding a
    // long-lived connection — every request adds a `once('close')` listener,
    // and removing only the request's own 'data' listener would let the count
    // grow by one per request for the life of the
    // connection (MaxListenersExceededWarning at request 11).
    // This drives N requests over ONE server-side socket
    // and asserts the listener count stays flat.
    const server = Fastify({ logger: false });
    const adapter = createFakeHttpAdapter({
      mountPath: '/mcp',
      handleHttp: async (_req, res) => {
        res.writeHead(200);
        res.end('{}');
      },
    });

    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });

    let serverSocket: import('node:net').Socket | undefined;
    server.server.on('connection', (socket) => {
      serverSocket = socket;
    });

    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const REQUEST_COUNT = 20;
    for (let i = 0; i < REQUEST_COUNT; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/mcp', method: 'GET', agent },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    expect(serverSocket).toBeDefined();
    expect(serverSocket?.listenerCount('close')).toBe(1);

    agent.destroy();
    await server.close();
  });

  it('getAdapterHealth falls back to fail when health() itself throws', async () => {
    const adapter = createFakeProtocolAdapter({
      health: async () => {
        throw new Error('health check exploded');
      },
    });
    const runtime: AdapterRuntime = { adapter };
    const health = await getAdapterHealth(runtime, clock);
    expect(health.status).toBe('fail');
    expect(health.detail).toContain('health check exploded');
  });

  it('a handleHttp that throws still results in a response and does not crash the server', async () => {
    const server = Fastify({ logger: false });
    const adapter = createFakeHttpAdapter({
      mountPath: '/broken',
      handleHttp: async () => {
        throw new Error('adapter transport bug');
      },
    });

    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.ready();

    const res = await server.inject({ method: 'GET', url: '/broken' });
    expect(res.statusCode).toBe(500);
    await server.close();
  });

  it('supports a mountPath with a trailing slash', async () => {
    const server = Fastify({ logger: false });
    const adapter = createFakeHttpAdapter({ mountPath: '/mcp/' });
    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/mcp/nested' });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('does not try to write a second response when handleHttp throws after already sending headers', async () => {
    const server = Fastify({ logger: false });
    const adapter = createFakeHttpAdapter({
      mountPath: '/mcp',
      handleHttp: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('partial');
        throw new Error('boom after headers sent');
      },
    });
    await startAndMountAdapters({
      server,
      adapters: [adapter],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/mcp' });
    // Fastify's injected response still completes; status reflects what the
    // adapter itself wrote (200), not a synthetic 500, since headers were
    // already sent before the throw.
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('getAdapterHealth tolerates a non-Error value thrown by health()', async () => {
    const adapter = createFakeProtocolAdapter({
      health: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'plain string failure';
      },
    });
    const health = await getAdapterHealth({ adapter }, clock);
    expect(health.status).toBe('fail');
    expect(health.detail).toBe('plain string failure');
  });

  it('stopAdapters calls stop() on every adapter and tolerates one throwing', async () => {
    const stopped: string[] = [];
    const good = createFakeProtocolAdapter({
      name: 'http',
      stop: async () => {
        stopped.push('good');
      },
    });
    const bad = createFakeProtocolAdapter({
      name: 'mcp',
      stop: async () => {
        throw new Error('stop failed');
      },
    });
    await stopAdapters([{ adapter: good }, { adapter: bad }], NOOP_LOGGER);
    expect(stopped).toEqual(['good']);
  });
});

describe('adapter-owned additional HTTP routes', () => {
  /** A protocol whose spec pins a discovery URL outside its own mount. */
  function cardAdapter(overrides: Partial<HttpProtocolAdapter> = {}): HttpProtocolAdapter {
    return createFakeHttpAdapter({
      name: 'a2a',
      mountPath: '/fake',
      additionalHttpRoutes: [
        {
          method: 'GET',
          path: '/.well-known/fake-card.json',
          handleHttp: async (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"card":true}');
          },
        },
      ],
      ...overrides,
    });
  }

  async function mount(adapters: readonly ProtocolAdapter[]): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    await startAndMountAdapters({
      server,
      adapters,
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.ready();
    return server;
  }

  it('mounts the primary mount and the fixed route', async () => {
    const server = await mount([cardAdapter()]);

    expect((await server.inject({ method: 'GET', url: '/fake' })).payload).toBe(
      'fake-adapter-response',
    );
    const card = await server.inject({ method: 'GET', url: '/.well-known/fake-card.json' });
    expect(card.statusCode).toBe(200);
    expect(card.payload).toBe('{"card":true}');

    await server.close();
  });

  it('scopes a fixed route to its declared method', async () => {
    const server = await mount([cardAdapter()]);
    const res = await server.inject({ method: 'POST', url: '/.well-known/fake-card.json' });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('hands a POST body to a fixed route unconsumed, like the mount', async () => {
    const sent = JSON.stringify({ hello: 'world' });
    let seen = '';
    const adapter = cardAdapter({
      additionalHttpRoutes: [
        {
          method: 'POST',
          path: '/.well-known/fake-card.json',
          handleHttp: async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            seen = Buffer.concat(chunks).toString('utf8');
            res.writeHead(200);
            res.end();
          },
        },
      ],
    });
    const server = await mount([adapter]);

    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/fake-card.json',
      headers: { 'content-type': 'application/json' },
      payload: sent,
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toBe(sent);

    await server.close();
  });

  it('isolates a throwing fixed-route handler, leaving the mount serving', async () => {
    const adapter = cardAdapter({
      additionalHttpRoutes: [
        {
          method: 'GET',
          path: '/.well-known/fake-card.json',
          handleHttp: async () => {
            throw new Error('card generation blew up');
          },
        },
      ],
    });
    const server = await mount([adapter]);

    expect(
      (await server.inject({ method: 'GET', url: '/.well-known/fake-card.json' })).statusCode,
    ).toBe(500);
    expect((await server.inject({ method: 'GET', url: '/fake' })).statusCode).toBe(200);

    await server.close();
  });

  it('mounts no fixed route for an adapter that failed to start', async () => {
    const server = Fastify({ logger: false });
    const runtimes = await startAndMountAdapters({
      server,
      adapters: [
        cardAdapter({
          start: async () => {
            throw new Error('nope');
          },
        }),
        createFakeHttpAdapter({ name: 'mcp', mountPath: '/mcp' }),
      ],
      context: fakeContext(),
      logger: NOOP_LOGGER,
      clock,
    });
    await server.ready();

    expect(runtimes[0]?.startFailure?.status).toBe('fail');
    expect(
      (await server.inject({ method: 'GET', url: '/.well-known/fake-card.json' })).statusCode,
    ).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/fake' })).statusCode).toBe(404);
    // The healthy adapter is untouched by its neighbour's failure.
    expect((await server.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(200);

    await server.close();
  });

  // Fastify would only notice these inside deferred route registration and
  // fail server.ready() with an FST_ERR_DUPLICATED_ROUTE naming no adapter.
  it('rejects two adapters claiming the same fixed route, before either starts', async () => {
    const server = Fastify({ logger: false });
    const started: string[] = [];
    const first = cardAdapter({ start: async () => void started.push('a2a') });
    const second = createFakeHttpAdapter({
      name: 'mcp',
      mountPath: '/mcp',
      start: async () => void started.push('mcp'),
      additionalHttpRoutes: [
        {
          method: 'GET',
          path: '/.well-known/fake-card.json',
          handleHttp: async (_req, res) => {
            res.end();
          },
        },
      ],
    });

    await expect(
      startAndMountAdapters({
        server,
        adapters: [first, second],
        context: fakeContext(),
        logger: NOOP_LOGGER,
        clock,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(started).toEqual([]);

    await server.close();
  });

  it('rejects a fixed route swallowed by another adapter mount wildcard', async () => {
    const server = Fastify({ logger: false });
    const nested = createFakeHttpAdapter({
      name: 'mcp',
      mountPath: '/mcp',
      additionalHttpRoutes: [
        {
          method: 'GET',
          path: '/fake/card',
          handleHttp: async (_req, res) => {
            res.end();
          },
        },
      ],
    });

    await expect(
      startAndMountAdapters({
        server,
        adapters: [cardAdapter(), nested],
        context: fakeContext(),
        logger: NOOP_LOGGER,
        clock,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    await server.close();
  });

  it('allows an adapter to serve a fixed route under its own mount', async () => {
    const server = await mount([
      cardAdapter({
        additionalHttpRoutes: [
          {
            method: 'GET',
            path: '/fake/card',
            handleHttp: async (_req, res) => {
              res.writeHead(200);
              res.end('own-sub-route');
            },
          },
        ],
      }),
    ]);

    expect((await server.inject({ method: 'GET', url: '/fake/card' })).payload).toBe(
      'own-sub-route',
    );
    await server.close();
  });
});
