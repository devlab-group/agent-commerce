/**
 * Defense in depth against persisting secrets. Receipt, event and payment
 * metadata must not carry secrets (docs/contracts.md, "Store no secrets"); at
 * the persistence boundary this module replaces secret-shaped values rather
 * than rejecting the write, because event persistence must not break a
 * commerce flow.
 */

// Matches anywhere in the key (only `auth` and `proof` must be the whole key),
// so an audit field whose name contains "token", "session", "jwt" or similar
// persists as [REDACTED]
const SECRET_KEY_PATTERN =
  /private[-_ ]?key|secret|password|mnemonic|seed[-_ ]?phrase|api[-_ ]?key|authoriz(e|ation)|^auth$|auth[-_]?header|payment[-_ ]?proof|^proof$|x-payment|signature|signed[-_ ]?message|token|bearer|credential|cookie|session|jwt/i;

const REDACTED = '[REDACTED]';

/** True if `key` looks like it names a secret value */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Returns a copy with every value under a secret-shaped key replaced, at any
 * depth. Clean input comes back equal to itself.
 */
export function redact<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactValue(inner);
    }
    return out;
  }
  return value;
}
