/**
 * Imports `src/config` on demand, so a module that fails to load breaks only
 * the commands that read config, not `version` or `--help`. Validate, doctor
 * and init accept an injected loader for tests that do not read the filesystem.
 */
import type { GatewayConfig as GatewayConfigType } from '../../config';
import { CommerceError } from '../../core';

export type GatewayConfig = GatewayConfigType;

export interface LoadConfigOptions {
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export type ConfigLoader = (options?: LoadConfigOptions) => Promise<GatewayConfig>;

/** Validates an already-built raw config object, without touching the disk */
export type ConfigParser = (raw: unknown, env?: NodeJS.ProcessEnv) => Promise<GatewayConfig>;

async function importConfig(): Promise<typeof import('../../config')> {
  try {
    return await import('../../config');
  } catch (err) {
    throw new CommerceError(
      'INTERNAL_ERROR',
      `the configuration module could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function loadConfigDynamic(options: LoadConfigOptions = {}): Promise<GatewayConfig> {
  return (await importConfig()).loadConfig(options);
}

/** Validates a raw config object in memory; `init` uses it to validate before writing */
export async function parseConfigDynamic(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayConfig> {
  return (await importConfig()).parseConfig(raw, env);
}
