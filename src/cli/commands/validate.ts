import { ZodError } from 'zod';
import { isCommerceError } from '../../core/index.js';
import { type ConfigLoader, loadConfigDynamic } from '../lib/config-client.js';
import type { Io } from '../lib/io.js';
import {
  fillEnvFromLocalChainManifest,
  LOCAL_CHAIN_MANIFEST_PATH,
  MANIFEST_FILLABLE_ENV_VAR_NAMES,
  type ManifestEnvFill,
} from '../lib/manifest-env.js';

export interface ValidateOptions {
  readonly configPath?: string;
}

export interface ValidateDeps {
  readonly loadConfig?: ConfigLoader;
  readonly fillEnvFromManifest?: (env: NodeJS.ProcessEnv) => ManifestEnvFill;
}

/**
 * Formats a config-loading failure into an actionable report.
 *
 * Handles the three error shapes `src/config` can produce:
 * a `CommerceError('CONFIG_INVALID', …)` with structured details, a raw
 * `ZodError` (schema errors, one line per failing path), or a plain Error
 * (e.g. a YAML syntax error, or the "config package not available yet"
 * integration-gap error). Never prints a resolved `${ENV}` value — only ever
 * the variable name, which the underlying error message is expected to carry.
 *
 * `manifestFound` adds one more hint line when the failure is specifically an
 * unresolved variable that `.deploy/local.json` would have supplied, had
 * `npm run chain:deploy` been run — see `../lib/manifest-env.js`.
 */
export function formatConfigError(err: unknown, manifestFound = false): string {
  if (isCommerceError(err)) {
    const lines = [`FAIL  ${err.code}: ${err.message}`];
    if (err.details !== undefined) {
      lines.push(`      details: ${JSON.stringify(err.details)}`);
    }
    const variable = err.details?.['variable'];
    if (
      !manifestFound &&
      typeof variable === 'string' &&
      MANIFEST_FILLABLE_ENV_VAR_NAMES.has(variable)
    ) {
      lines.push(
        `      hint: "npm run chain:deploy" writes ${LOCAL_CHAIN_MANIFEST_PATH}, which validate/doctor read automatically to fill local X402_*/MERCHANT_WALLET placeholders.`,
      );
    }
    return lines.join('\n');
  }
  if (err instanceof ZodError) {
    const lines = ['FAIL  Configuration schema errors:'];
    for (const issue of err.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      lines.push(`      - ${path}: ${issue.message}`);
    }
    return lines.join('\n');
  }
  if (err instanceof Error) {
    return `FAIL  ${err.message}`;
  }
  return `FAIL  ${String(err)}`;
}

/** `agent-commerce validate [--config <path>]`. Exit code is non-zero on invalid configuration. */
export async function runValidate(
  options: ValidateOptions,
  io: Io,
  deps: ValidateDeps = {},
): Promise<number> {
  const loadConfig = deps.loadConfig ?? loadConfigDynamic;
  const fillEnvFromManifest = deps.fillEnvFromManifest ?? fillEnvFromLocalChainManifest;
  const { env, filled, manifestFound } = fillEnvFromManifest(process.env);
  if (filled.length > 0) {
    io.stdout(`using local chain manifest ${LOCAL_CHAIN_MANIFEST_PATH} for ${filled.join(', ')}`);
  }
  try {
    const config = await loadConfig({
      ...(options.configPath !== undefined ? { path: options.configPath } : {}),
      env,
    });
    io.stdout('PASS  Configuration is valid');
    io.stdout(`      merchant: ${config.merchant.name} (${config.merchant.id})`);
    io.stdout(`      resources: ${config.resources.length}`);
    io.stdout(
      `      protocols: http=${config.protocols.http.enabled ? 'on' : 'off'} mcp=${config.protocols.mcp.enabled ? 'on' : 'off'}`,
    );
    io.stdout(`      payments: x402=${config.payments.x402?.enabled === true ? 'on' : 'off'}`);
    return 0;
  } catch (err) {
    io.stderr(formatConfigError(err, manifestFound));
    return 1;
  }
}
