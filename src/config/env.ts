/**
 * `${VAR}` / `${VAR:-default}` substitution over a parsed YAML value.
 *
 * Only string leaves change; the caller coerces numeric and boolean strings
 * afterwards. `${VAR}` requires `VAR` in `env`, where an empty string counts as
 * present. `${VAR:-default}` uses `default` when `VAR` is absent or empty, as a
 * shell does. An unresolved placeholder fails config loading, so startup never
 * proceeds with a missing secret. There is no escape for a literal `${NAME}`.
 *
 * Anything else brace-shaped is refused, including nesting (`${A:-${B}}`) and
 * shell forms (`${VAR-x}`, `${VAR:=x}`, `${VAR:?x}`) that would otherwise load
 * as literal text: `adminToken: ${ADMIN_TOKEN-fallback}` would make that
 * literal the ledger credential. A bare `$VAR` is left alone, so values may
 * contain a dollar sign.
 *
 * The template rules are checked before substitution, and errors name the
 * variable and the config path, never a resolved value.
 */
import { CommerceError } from '../core';
import { isRecord } from '../core/is-record';

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

// An innermost brace token: `${`, then no braces, then `}`
const BRACE_TOKEN = /\$\{[^{}]*\}/g;

// PLACEHOLDER_PATTERN's grammar, anchored, for validating one token
const SUPPORTED_TOKEN = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/;

// A placeholder whose default segment opens another placeholder
const NESTED_PLACEHOLDER = /\$\{[^{}]*\$\{/;

export function substituteEnv(value: unknown, env: NodeJS.ProcessEnv, path = '$'): unknown {
  if (typeof value === 'string') {
    return substituteString(value, env, path);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => substituteEnv(entry, env, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = substituteEnv(entry, env, `${path}.${key}`);
    }
    return result;
  }
  return value;
}

function substituteString(value: string, env: NodeJS.ProcessEnv, path: string): string {
  assertTemplateIsSupported(value, path);
  return substituteOnce(value, env, path);
}

/**
 * Refuses a template this module cannot honor, before any substitution runs.
 *
 * For `${A:-${B}}`, `[^}]*` cannot span the inner `}`, so the match consumes
 * `${A:-${B` and leaves a stray `}`. With `A` set, substitution would succeed
 * and append that `}` to the value unnoticed, so `adminToken` would become a
 * credential the operator does not hold.
 */
function assertTemplateIsSupported(value: string, path: string): void {
  if (NESTED_PLACEHOLDER.test(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" nests placeholders (e.g. "\${A:-\${B}}"), which is not supported: the inner one is not resolved and its closing brace ends up in the value. Use a plain default, or set the variable.`,
      { details: { path } },
    );
  }

  for (const [token] of value.matchAll(BRACE_TOKEN)) {
    if (SUPPORTED_TOKEN.test(token)) continue;
    // Quotes the token, not the value; before substitution it holds no secret
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" contains "${token}", which is not a supported placeholder. Only "\${VAR}" and "\${VAR:-default}" are recognized; shell forms such as "\${VAR-default}", "\${VAR:=default}" and "\${VAR:?message}" would load as literal text.`,
      { details: { path, token } },
    );
  }
}

function substituteOnce(value: string, env: NodeJS.ProcessEnv, path: string): string {
  return value.replace(
    PLACEHOLDER_PATTERN,
    (_match, name: string, hasDefault: string | undefined, def: string | undefined) => {
      const envValue = env[name];

      if (hasDefault !== undefined) {
        if (envValue === undefined || envValue === '') return def ?? '';
        return envValue;
      }

      if (envValue === undefined) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `Unresolved environment variable "\${${name}}" referenced at config path "${path}"`,
          { details: { variable: name, path } },
        );
      }
      return envValue;
    },
  );
}
