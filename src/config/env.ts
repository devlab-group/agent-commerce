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
 * The resolved *value* of a variable is never included in any error message —
 * only the variable *name* and the config path are.
 */
import { CommerceError } from '../core/index.js';

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

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
  const substituted = substituteOnce(value, env, path);

  // `${A:-${B}}` with A unset produced the literal string
  // `${B}` — an unresolved placeholder that survived into the config, directly
  // contradicting this module's promise that one fails loading immediately.
  // (`[^}]*` cannot span the inner `}`, so the default captured is `${B`, and
  // the trailing `}` is ordinary text.) Refusing is the fail-closed reading of
  // that promise; resolving recursively would mean deciding what `${A:-${B:-c}}`
  // and a self-reference should do, which no config here needs. A `${` with no
  // closing brace is left alone — it is not a placeholder.
  PLACEHOLDER_PATTERN.lastIndex = 0;
  if (PLACEHOLDER_PATTERN.test(substituted)) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    const residual = PLACEHOLDER_PATTERN.exec(substituted)?.[0] ?? '${…}';
    PLACEHOLDER_PATTERN.lastIndex = 0;
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" still contains the unresolved placeholder "${residual}" after substitution — nested placeholders (e.g. "\${A:-\${B}}") are not supported. Use a plain default, or set the variable.`,
      { details: { path, residual } },
    );
  }
  return substituted;
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
