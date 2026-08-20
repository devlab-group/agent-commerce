/**
 * `createGateway()` — the Fastify server. Fully usable (and tested) with
 * fakes, without `main.ts` (docs/contracts.md "Composition root").
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from '../config/index.js';
import {
  createEventBus,
  createExecutionPipeline,
  createResourceRegistry,
  HttpBackendExecutor,
} from '../core/execution/index.js';
import {
  type BackendExecutor,
  type Clock,
  type ExecutionPipeline,
  type IdGenerator,
  type Logger,
  type PaymentProvider,
  type ProtocolAdapter,
  type ProtocolAdapterContext,
  type ReceiptStore,
  type ResourceRegistry,
  systemClock,
} from '../core/index.js';
import { buildAccessControlHook } from './access-control.js';
import {
  type AdapterRuntime,
  MOUNT_BODY_LIMIT_BYTES,
  startAndMountAdapters,
  stopAdapters,
} from './adapters.js';
import { createDefaultIdGenerator } from './ids.js';
import { buildNotFoundHandler, createGatewayLogger, fastifyLoggerOptions } from './logger.js';
import { registerRoutes } from './routes.js';

const REQUEST_ID_HEADER = 'x-request-id';
// an unvalidated caller-supplied id becomes the audit trail's
// correlation key — a caller could reuse a legitimate flow's id to conflate
// records, or write an unbounded string into every row. A client id is only
// accepted in this constrained form; anything else gets a gateway-minted one.
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export interface GatewayOptions {
  readonly config: GatewayConfig;
  readonly store: ReceiptStore;
  readonly paymentProviders: readonly PaymentProvider[];
  readonly protocolAdapters: readonly ProtocolAdapter[];
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Override for tests. */
  readonly backend?: BackendExecutor;
}

export interface GatewayInstance {
  readonly pipeline: ExecutionPipeline;
  readonly resources: ResourceRegistry;
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
  /** Fastify instance, for `.inject()` in tests. */
  readonly server: FastifyInstance;
}

export async function createGateway(options: GatewayOptions): Promise<GatewayInstance> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createDefaultIdGenerator();
  const logger = options.logger ?? createGatewayLogger({ name: options.config.merchant.id }).core;
  const backend = options.backend ?? new HttpBackendExecutor({ logger });

  const resources = createResourceRegistry(options.config.resources);
  const eventBus = createEventBus({ store: options.store, logger });
  const pipeline = createExecutionPipeline({
    resources,
    paymentProviders: options.paymentProviders,
    store: options.store,
    backend,
    events: eventBus,
    logger,
    clock,
    ids,
  });

  const server = Fastify({
    // One number for both surfaces — see adapters.ts's doc comment
    // on MOUNT_BODY_LIMIT_BYTES for why they're enforced two different ways.
    bodyLimit: MOUNT_BODY_LIMIT_BYTES,
    genReqId: (rawReq) => {
      const header = rawReq.headers[REQUEST_ID_HEADER];
      const value = Array.isArray(header) ? header[0] : header;
      return value !== undefined && CLIENT_REQUEST_ID_PATTERN.test(value) ? value : ids.next('req');
    },
    logger: fastifyLoggerOptions({ name: `${options.config.merchant.id}-http` }),
  });

  // See buildNotFoundHandler's own doc comment (logger.ts) — this
  // is what leaked the SSE ?adminToken= query param at info level on any 404
  // (a typo'd route, even a trailing slash on a real one).
  server.setNotFoundHandler(buildNotFoundHandler());

  // Host/Origin/admin-token gate — see access-control.ts. Closed by default:
  // no allowedOrigins means no browser can read anything cross-origin, and no
  // adminToken means the ledger routes 404 rather than serving openly.
  server.addHook(
    'onRequest',
    buildAccessControlHook({
      publicBaseUrl: options.config.merchant.publicBaseUrl,
      allowedOrigins: options.config.server.allowedOrigins,
    }),
  );

  const adapterRuntimes: AdapterRuntime[] = [];

  registerRoutes({
    server,
    config: options.config,
    pipeline,
    resources,
    store: options.store,
    paymentProviders: options.paymentProviders,
    eventBus,
    clock,
    adapterRuntimes,
    logger,
  });

  const context: ProtocolAdapterContext = {
    pipeline,
    resources,
    events: eventBus,
    logger,
    clock,
    ids,
    publicBaseUrl: options.config.merchant.publicBaseUrl,
  };

  const started = await startAndMountAdapters({
    server,
    adapters: options.protocolAdapters,
    context,
    logger,
    clock,
  });
  adapterRuntimes.push(...started);

  await server.ready();

  return {
    pipeline,
    resources,
    async listen(): Promise<{ url: string }> {
      const url = await server.listen({
        port: options.config.server.port,
        host: options.config.server.host,
      });
      return { url };
    },
    async close(): Promise<void> {
      await stopAdapters(adapterRuntimes, logger);
      await server.close();
    },
    server,
  };
}
