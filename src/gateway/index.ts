/**
 * src/gateway
 *
 * Fastify server: HTTP resource routes, adapter mounting and health.
 * `src/main.ts` (the composition root) is not exported here.
 */

export { createDefaultIdGenerator } from './ids.js';
export type { CreatedGatewayLogger, CreateGatewayLoggerOptions } from './logger.js';
export { createGatewayLogger, REDACT_PATHS } from './logger.js';
export type { GatewayInstance, GatewayOptions } from './server.js';
export { createGateway } from './server.js';
