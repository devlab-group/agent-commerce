/**
 * The demo merchant API: an ordinary HTTP service that knows nothing about
 * the gateway, agents, MCP or x402, because the gateway fronts a plain,
 * pre-existing backend. Tests call `inject()` on the app `buildApp()` returns;
 * `main.ts` is the process entry point.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { getMarketReport } from './report';
import { getWeather } from './weather';

export interface BuildAppOptions {
  /** Fastify logger option or a pino-compatible logger. Defaults to pino at `LOG_LEVEL` or info */
  readonly logger?: boolean | FastifyBaseLogger | Record<string, unknown>;
  /** Clock override for deterministic tests. Defaults to `() => new Date()` */
  readonly now?: () => Date;
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

  return app;
}
