/**
 * `${VAR}` / `${VAR:-default}` substitution over an arbitrary parsed-YAML value.
 *
 * Only string leaves are touched; numbers/booleans/null pass through untouched
 * (the caller coerces the *resulting* string back into a number/boolean where
 * the schema expects one). An unresolved placeholder fails config loading
 * immediately — startup must never proceed with an unresolved secret. That
 * includes one left behind by a *nested* placeholder such as `${A:-${B}}`,
 * which is rejected rather than silently passed through. There is no
 * escape syntax for a literal `${NAME}`; nothing in this config format needs
 * one, and adding it would mean two ways to write every value.
 *
 * `${VAR}` (no default) requires `VAR` to be present in `env` (any value,
 * including an empty string, counts as present).
 * `${VAR:-default}` falls back to `default` when `VAR` is absent OR empty,
 * matching common shell semantics.
 *
 * Anything else brace-shaped is refused: `${VAR-x}`, `${VAR:=x}`, `${VAR:?x}`
 * are valid *shell* and would otherwise load as literal strings. That is
 * harmless where a downstream check rejects the literal, and quietly wrong for
 * a free-string field — `adminToken: ${ADMIN_TOKEN-fallback}` would run the
 * gateway with that literal as the ledger credential while the operator
 * believed an env secret gated it. A bare `$VAR` is deliberately left alone: it
 * is not brace-shaped, and refusing it would reject values that legitimately
 * contain a dollar sign.
 *
 * Every rule above is decided from the **template**, before substitution.
 * Deciding afterwards is how `${A:-${B}}` used to corrupt a value on the one
 * branch its guard did not cover, and how a resolved secret containing a
 * `${…}`-shaped fragment used to get quoted back in the error text.
 *
 * The resolved *value* of a variable is never included in any error message —
 * only the variable *name* and the config path are.
 */
import { CommerceError } from '../core/index.js';

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

/** An innermost brace token: `${` … `}` with no braces between. */
const BRACE_TOKEN = /\$\{[^{}]*\}/g;

/** The same grammar as PLACEHOLDER_PATTERN, anchored, for validating one token. */
const SUPPORTED_TOKEN = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/;

/** A placeholder whose default segment opens another placeholder. */
const NESTED_PLACEHOLDER = /\$\{[^{}]*\$\{/;

export function substituteEnv(value: unknown, env: NodeJS.ProcessEnv, path = '$'): unknown {
  if (typeof value === 'string') {
    return substituteString(value, env, path);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => substituteEnv(entry, env, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
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
 * Refuses a template this module cannot honour, before any substitution runs.
 *
 * `${A:-${B}}` is the case that motivated this. `[^}]*` cannot span the inner
 * `}`, so the match consumes `${A:-${B` and leaves a stray `}` behind. When `A`
 * is unset the leftover `${B}` was visible afterwards and got caught; when `A`
 * is *set* — the normal case, and the whole reason someone writes a default —
 * substitution succeeded and the stray `}` was appended to the resolved value
 * with nothing to notice it. For `adminToken` that means the gateway compares
 * against a credential the operator does not hold, with no diagnostic.
 *
 * Deciding from the template covers both branches with one rule, and means no
 * error message is ever derived from a resolved value.
 */
function assertTemplateIsSupported(value: string, path: string): void {
  if (NESTED_PLACEHOLDER.test(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" nests placeholders (e.g. "\${A:-\${B}}"), which is not supported — the inner one is not resolved and its closing brace ends up in the value. Use a plain default, or set the variable.`,
      { details: { path } },
    );
  }

  BRACE_TOKEN.lastIndex = 0;
  for (const [token] of value.matchAll(BRACE_TOKEN)) {
    if (SUPPORTED_TOKEN.test(token)) continue;
    // The token itself, never the surrounding value: this runs pre-substitution,
    // so it cannot contain a resolved secret.
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" contains "${token}", which is not a supported placeholder. Only "\${VAR}" and "\${VAR:-default}" are recognised; shell forms such as "\${VAR-default}", "\${VAR:=default}" and "\${VAR:?message}" would load as literal text.`,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
