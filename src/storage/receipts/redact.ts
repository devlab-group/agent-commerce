/**
 * Defence-in-depth against accidentally persisting secrets.
 *
 * The gateway and payment providers are expected to never place secrets into
 * `CommerceReceipt.metadata`, `CommerceEvent.data` or `PaymentResult.metadata`
 * (see docs/contracts.md, "Store NO secrets"). This module is a second line
 * of defence at the persistence boundary: any key that *looks* like it holds
 * a private key, an auth header or a raw payment proof is stripped — never
 * persisted — rather than rejecting the whole write, so a logging bug never
 * takes down an otherwise-successful commerce flow (appendEvent especially
 * must never throw into the caller's flow).
 */
/**
 * The bearer-token family was missing — `token`, `bearerToken`,
 * `adminToken`, `authToken`, `credential`, `cookie`, `sessionId`, `jwt` all
 * returned false. Nothing writes such a key today, which is exactly the state
 * a second line of defence is for; and this data also lands in a
 * file that is now owner-only precisely because it is worth protecting.
 */
const SECRET_KEY_PATTERN =
  /private[-_ ]?key|secret|password|mnemonic|seed[-_ ]?phrase|api[-_ ]?key|authoriz(e|ation)|^auth$|auth[-_]?header|payment[-_ ]?proof|^proof$|x-payment|signature|signed[-_ ]?message|token|bearer|credential|cookie|session|jwt/i;

const REDACTED = '[REDACTED]';

/** True if `key` looks like it names a secret value. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Recursively strip values whose key looks secret-shaped, returning a new
 * object. Safe to call on already-clean data (no-op in that case).
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

/** True if `value` (recursively) contains any key that looks secret-shaped. */
export function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSecretKey);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, inner]) => isSecretKey(key) || containsSecretKey(inner),
    );
  }
  return false;
}
