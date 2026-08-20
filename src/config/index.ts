/**
 * src/config
 *
 * `config.yaml` schema, loader and environment substitution.
 */

export { substituteEnv } from './env.js';
export type { LoadConfigOptions } from './load.js';
export { loadConfig } from './load.js';
export type { GatewayConfig } from './schema.js';
export { parseConfig } from './schema.js';
