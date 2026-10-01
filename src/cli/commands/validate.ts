import { isCommerceError } from '../../core';
import { type ConfigLoader, loadConfigDynamic } from '../lib/config-client';
import type { Io } from '../lib/io';
import {
  fillEnvFromLocalChainManifest,
  LOCAL_CHAIN_MANIFEST_PATH,
  MANIFEST_FILLABLE_ENV_VAR_NAMES,
  type ManifestEnvFill,
} from '../lib/manifest-env';

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
 * `src/config` reports file, YAML, schema and environment failures as
 * `CommerceError('CONFIG_INVALID')` with structured details, and
 * `config-client` reports a config module that fails to load as
 * `INTERNAL_ERROR`. Nothing here adds a resolved `${ENV}` value: the config
 * error names only the variable.
 *
 * When no manifest was found, an unresolved variable that `.deploy/local.json`
 * would supply gets a hint to run `npm run chain:deploy` (see
 * `../lib/manifest-env`).
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
  if (err instanceof Error) {
    return `FAIL  ${err.message}`;
  }
  return `FAIL  ${String(err)}`;
}

/** `agent-commerce validate [--config <path>]`. Exits non-zero on invalid configuration */
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
      `      protocols: http=${config.protocols.http.enabled ? 'on' : 'off'} mcp=${config.protocols.mcp.enabled ? 'on' : 'off'} a2a=${config.protocols.a2a.enabled ? 'on' : 'off'} acp=${config.protocols.acp.enabled ? 'on' : 'off'}`,
    );
    const onOff = (enabled: boolean | undefined): string => (enabled === true ? 'on' : 'off');
    io.stdout(
      `      payments: x402=${onOff(config.payments.x402?.enabled)} mpp=${onOff(config.payments.mpp?.enabled)}`,
    );
    io.stdout(`      authorization: ap2=${onOff(config.authorization?.ap2.enabled)}`);
    return 0;
  } catch (err) {
    io.stderr(formatConfigError(err, manifestFound));
    return 1;
  }
}
