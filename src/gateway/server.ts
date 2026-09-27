// `createGateway()`: the Fastify server, usable with injected fakes and without `main.ts`

import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from '../config';
import {
  type AuthorizationProvider,
  type BackendExecutor,
  type Clock,
  type CommerceResource,
  type ExecutionPipeline,
  type IdGenerator,
  type Logger,
  type PaymentProvider,
  type ProtocolAdapter,
  type ProtocolAdapterContext,
  type ReceiptStore,
  type ResourceRegistry,
  systemClock,
} from '../core';
import {
  createExecutionPipeline,
  createResourceRegistry,
  createStoreEventSink,
  HttpBackendExecutor,
} from '../core/execution';
import { buildAccessControlHook } from './access-control';
import {
  type AdapterRuntime,
  MOUNT_BODY_LIMIT_BYTES,
  startAndMountAdapters,
  stopAdapters,
} from './adapters';
import { createDefaultIdGenerator } from './ids';
import { buildNotFoundHandler, createGatewayLogger, fastifyLoggerOptions } from './logger';
import { registerRoutes } from './routes';

const REQUEST_ID_HEADER = 'x-request-id';
// The audit request id is always minted: a caller-chosen one could repeat
// another flow's id and interleave its audit rows with that flow's. A
// caller's X-Request-Id in this bounded form survives only as the
// `clientRequestId` binding on the request's log lines.
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function clientRequestIdOf(raw: IncomingMessage): string | undefined {
  const header = raw.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && CLIENT_REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

export interface GatewayOptions {
  readonly config: GatewayConfig;
  readonly store: ReceiptStore;
  readonly paymentProviders: readonly PaymentProvider[];
  /** Defaults to none; each resource declares the methods it requires */
  readonly authorizationProviders?: readonly AuthorizationProvider[];
  readonly protocolAdapters: readonly ProtocolAdapter[];
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Override for tests */
  readonly backend?: BackendExecutor;
}

export interface GatewayInstance {
  readonly pipeline: ExecutionPipeline;
  readonly resources: ResourceRegistry;
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
  /** Fastify instance, for `.inject()` in tests */
  readonly server: FastifyInstance;
}

// Ingress labels a proof with `paymentMethods[0]`, while the pipeline selects
// the first method backed by a provider. Move backed methods first, preserving
// declared order within each group, so both paths select the same rail.
function withProviderBackedMethodsFirst(
  resource: CommerceResource,
  providers: readonly PaymentProvider[],
): CommerceResource {
  const backed = (method: string) => providers.some((provider) => provider.name === method);
  const ordered = [
    ...resource.paymentMethods.filter(backed),
    ...resource.paymentMethods.filter((method) => !backed(method)),
  ];
  return ordered.some((method, i) => method !== resource.paymentMethods[i])
    ? { ...resource, paymentMethods: ordered }
    : resource;
}

export async function createGateway(options: GatewayOptions): Promise<GatewayInstance> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createDefaultIdGenerator();
  const logger = options.logger ?? createGatewayLogger({ name: options.config.merchant.id }).core;
  const backend = options.backend ?? new HttpBackendExecutor({ logger });

  const authorizationProviders = options.authorizationProviders ?? [];

  const resources = createResourceRegistry(
    options.config.resources.map((resource) =>
      withProviderBackedMethodsFirst(resource, options.paymentProviders),
    ),
  );
  const events = createStoreEventSink({ store: options.store, logger });
  const pipeline = createExecutionPipeline({
    resources,
    paymentProviders: options.paymentProviders,
    authorizationProviders,
    store: options.store,
    backend,
    events,
    logger,
    clock,
    ids,
  });

  const server = Fastify({
    // Same cap as adapter mounts, which enforce it on the socket instead
    bodyLimit: MOUNT_BODY_LIMIT_BYTES,
    genReqId: () => ids.next('req'),
    childLoggerFactory: (parent, bindings, childOptions, rawReq) => {
      const clientRequestId = clientRequestIdOf(rawReq);
      return parent.child(
        clientRequestId !== undefined ? { ...bindings, clientRequestId } : bindings,
        childOptions,
      );
    },
    logger: fastifyLoggerOptions({ name: `${options.config.merchant.id}-http` }),
  });

  // Fastify's default 404 handler logs the raw URL, query string included
  server.setNotFoundHandler(buildNotFoundHandler());

  // Host check and CORS for every request. Closed by default: with no
  // allowedOrigins, every request carrying an Origin is refused. The admin
  // token gate is per route, in routes.ts.
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
    authorizationProviders,
    clock,
    adapterRuntimes,
    logger,
  });

  const context: ProtocolAdapterContext = {
    pipeline,
    resources,
    events,
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
