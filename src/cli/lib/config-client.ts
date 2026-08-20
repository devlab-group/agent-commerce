/**
 * Single seam for the CLI's dependency on `src/config`.
 *
 * The import is dynamic, not static, on purpose: a static
 * `import … from '../../config/index.js'` would fail the whole module
 * graph the instant the package became unavailable for any reason (mid-flight
 * refactor, a broken build), taking down every CLI command — even `version`,
 * which never touches config — the moment this file is loaded. A dynamic
 * import only fails, catchably, when a command actually needs configuration.
 *
 * `runValidate` / `runDoctor` / `runInit` also accept the loader as an
 * injected dependency (defaulting to {@link loadConfigDynamic}), which keeps
 * their logic unit-testable without touching the filesystem or the real
 * package.
 */
import type { GatewayConfig as GatewayConfigType } from '../../config/index.js';

export type GatewayConfig = GatewayConfigType;

export interface LoadConfigOptions {
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export type ConfigLoader = (options?: LoadConfigOptions) => Promise<GatewayConfig>;

/** Validates an already-built raw config object, without touching the disk. */
export type ConfigParser = (raw: unknown, env?: NodeJS.ProcessEnv) => Promise<GatewayConfig>;

export async function loadConfigDynamic(options: LoadConfigOptions = {}): Promise<GatewayConfig> {
  let mod: typeof import('../../config/index.js');
  try {
    mod = await import('../../config/index.js');
  } catch (err) {
    throw new Error(
      `the configuration module could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return mod.loadConfig(options);
}

/**
 * In-memory validation, same module and same seam as {@link loadConfigDynamic}.
 *
 * Validating the object before writing means nothing lands unless it is
 * valid. Writing the file and *then* loading it back would leave an answer
 * that legitimately fails validation — no protocol selected, a typo'd
 * settlement address, a scheme-less backend URL — on disk under a printed
 * "PASS Wrote …", and tell the user to report their own input as a bug.
 */
export async function parseConfigDynamic(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayConfig> {
  let mod: typeof import('../../config/index.js');
  try {
    mod = await import('../../config/index.js');
  } catch (err) {
    throw new Error(
      `the configuration module could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return mod.parseConfig(raw, env);
}
