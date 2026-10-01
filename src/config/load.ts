/**
 * Locates and parses `config.yaml`, then hands the raw value to `parseConfig`
 * for validation
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, YAMLError } from 'yaml';
import { CommerceError } from '../core';
import { DEFAULT_CONFIG_FILENAME } from './filename';
import { type GatewayConfig, parseConfig } from './schema';

const CONFIG_PATH_ENV_VAR = 'AGENT_COMMERCE_CONFIG';

export interface LoadConfigOptions {
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<GatewayConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(options.path, env, cwd);

  let text: string;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    throw new CommerceError('CONFIG_INVALID', `Could not read configuration file "${configPath}"`, {
      details: { path: configPath },
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const { reason, details } = describeYamlError(error);
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration file "${configPath}" is not valid YAML: ${reason}`,
      {
        details: { path: configPath, ...details },
        // Kept for programmatic callers. Never print it: its `.message` quotes
        // the source line (see describeYamlError).
        cause: error,
      },
    );
  }

  return parseConfig(raw, env);
}

// Plain-English phrasing for common YAML error codes. Fixed strings, so they
// never carry file content; an unlisted code is shown bare.
const YAML_ERROR_EXPLANATIONS: Readonly<Record<string, string>> = {
  DUPLICATE_KEY: 'map keys must be unique',
  BAD_INDENT: 'bad indentation',
  TAB_AS_INDENT: 'tabs cannot be used for indentation',
  MISSING_CHAR: 'a required character is missing',
  BLOCK_AS_IMPLICIT_KEY: 'a block value cannot be used as a key (missing quotes, or a stray colon)',
  MULTILINE_IMPLICIT_KEY: 'a key spans multiple lines (missing quotes, or a stray colon)',
  UNEXPECTED_TOKEN: 'unexpected token',
};

/**
 * Describes a YAML failure from the error's structured `code` and `linePos`
 * only. The `yaml` package's `message` quotes the source line, and a syntax
 * error next to an inline secret (`server.adminToken`, a facilitator
 * `signerPrivateKey`) would print it in `validate` and `doctor` output.
 */
function describeYamlError(error: unknown): {
  reason: string;
  details: Record<string, unknown>;
} {
  if (!(error instanceof YAMLError)) {
    return { reason: 'unknown YAML parse error', details: {} };
  }
  const start = error.linePos?.[0];
  const where =
    start === undefined ? '' : ` at line ${String(start.line)}, column ${String(start.col)}`;
  const explanation = YAML_ERROR_EXPLANATIONS[error.code];
  const what = explanation === undefined ? error.code : `${error.code} (${explanation})`;
  return {
    reason: `${what}${where}`,
    details: {
      yamlErrorCode: error.code,
      ...(start === undefined ? {} : { line: start.line, column: start.col }),
    },
  };
}

function resolveConfigPath(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  if (explicitPath) return path.resolve(cwd, explicitPath);
  const fromEnv = env[CONFIG_PATH_ENV_VAR];
  if (fromEnv) return path.resolve(cwd, fromEnv);
  return path.resolve(cwd, DEFAULT_CONFIG_FILENAME);
}
