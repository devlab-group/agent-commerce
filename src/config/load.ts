/**
 * Locates and parses `config.yaml`, then hands the raw value to
 * `parseConfig`. Never trusts raw YAML before Zod validation.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, YAMLError } from 'yaml';
import { CommerceError } from '../core/index.js';
import { DEFAULT_CONFIG_FILENAME } from './filename.js';
import { type GatewayConfig, parseConfig } from './schema.js';

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
        // Retained for programmatic callers. Nothing in the CLI prints a
        // `cause`, and nothing should start: this is the object whose
        // `.message` carries the source excerpt (see below).
        cause: error,
      },
    );
  }

  return parseConfig(raw, env);
}

/**
 * A YAML failure described from the error's *structured* fields only.
 *
 * Deliberately not `error.message`: the `yaml` package builds that message
 * with a **code frame excerpt of the source line**, so a syntax error next to
 * an inline secret would reproduce it verbatim into `validate`/`doctor` output — including `doctor --json`, the output most
 * likely to be pasted into an issue or captured by CI:
 *
 * … is not valid YAML: Nested mappings are not allowed … at line 2, column 15:
 *
 * adminToken: super-secret-token-value
 * ^
 *
 * `server.adminToken` and `payments.x402.facilitator.signerPrivateKey` are
 * both legal as inline literals, so this was a real sink rather than a
 * hypothetical one — and it contradicted `validate`'s own promise never to
 * print a resolved value: it never printed a resolved `${ENV}`, only an
 * inlined one. `code` and `linePos` locate the fault exactly as well and
 * cannot contain file content.
 */
/**
 * Plain-English phrasing for the codes an operator actually hits, so replacing
 * the excerpt does not also cost the diagnostic its readability. These are
 * fixed strings chosen here — they can never contain file content, which is
 * the entire property that matters. Anything unlisted degrades to the bare
 * code, which is still precise.
 */
const YAML_ERROR_EXPLANATIONS: Readonly<Record<string, string>> = {
  DUPLICATE_KEY: 'map keys must be unique',
  BAD_INDENT: 'bad indentation',
  TAB_AS_INDENT: 'tabs cannot be used for indentation',
  MISSING_CHAR: 'a required character is missing',
  BLOCK_AS_IMPLICIT_KEY: 'a block value cannot be used as a key (missing quotes, or a stray colon)',
  MULTILINE_IMPLICIT_KEY: 'a key spans multiple lines (missing quotes, or a stray colon)',
  UNEXPECTED_TOKEN: 'unexpected token',
};

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
