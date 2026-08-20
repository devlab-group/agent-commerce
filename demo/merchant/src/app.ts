/**
 * The demo merchant API — an ordinary HTTP service that knows NOTHING about
 * the gateway, agents, MCP or x402 payments. That is the point of the demo:
 * the gateway fronts a plain, pre-existing backend.
 *
 * `buildApp()` is the testable factory (`fastify.inject()` in tests);
 * `main.ts` is the process entry point.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { getMarketReport } from './report.js';
import { getWeather } from './weather.js';

export interface BuildAppOptions {
  /** Fastify logger option, or a pre-built pino-compatible logger instance. Defaults to pino at 'info'. */
  readonly logger?: boolean | FastifyBaseLogger | Record<string, unknown>;
  /** Clock override for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Registers `/api/slow` and `/api/fail`.
   * These exist only so gateway integration tests can inject latency/errors
   * — a real backend must not ship them. Defaults to
   * `process.env.NODE_ENV !== 'production'`, the standard Node convention,
   * so this file keeps working unmodified as the demo it is, while a reader
   * who copies it as a starting point and sets NODE_ENV=production for
   * their real deployment gets them off with no code change.
   */
  readonly enableDemoFailureRoutes?: boolean;
}

/** Sleeping longer than this is never a legitimate test of timeout handling, just a way to hold a connection open. */
const MAX_SLOW_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get<{ Params: { city: string } }>('/api/weather/:city', async (request, reply) => {
    const city = request.params.city.trim();
    if (city.length === 0) {
      return reply.code(400).send({ error: 'city is required' });
    }
    return getWeather(city, now());
  });

  app.get('/api/report', async () => getMarketReport(now()));

  // --- Demo-only failure-injection routes, used by gateway integration tests. ---
  const enableDemoFailureRoutes =
    options.enableDemoFailureRoutes ?? process.env.NODE_ENV !== 'production';

  if (enableDemoFailureRoutes) {
    /**
     * DEMO-ONLY. Sleeps for `ms` milliseconds (default 1000, capped at
     * `MAX_SLOW_MS`) before responding, so integration tests can exercise
     * gateway backend-timeout handling.
     */
    app.get<{ Querystring: { ms?: string } }>('/api/slow', async (request, reply) => {
      const raw = request.query.ms ?? '1000';
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_SLOW_MS) {
        return reply.code(400).send({ error: `ms must be a number between 0 and ${MAX_SLOW_MS}` });
      }
      await sleep(ms);
      return { status: 'ok', sleptMs: ms };
    });

    /**
     * DEMO-ONLY. Responds with the given HTTP status (default 500), so
     * integration tests can exercise gateway backend-error handling.
     */
    app.get<{ Querystring: { status?: string } }>('/api/fail', async (request, reply) => {
      const raw = request.query.status ?? '500';
      const status = Number(raw);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        return reply
          .code(400)
          .send({ error: 'status must be an integer HTTP status code (100-599)' });
      }
      return reply.code(status).send({ error: 'Injected failure', status });
    });
  }

  return app;
}
