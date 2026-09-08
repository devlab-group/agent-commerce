/**
 * Identity and request fingerprints for ACP idempotency.
 *
 * The fingerprint is taken over the *parsed* JSON value, not the raw bytes: a
 * client that retries the same request through a different JSON serializer
 * (different key order, `1.0` where it first sent `1`, whitespace) is retrying,
 * not conflicting, and answering it with a 422 would be wrong. The distinctions
 * that do matter are kept: array order, `null` versus an absent property, and
 * type - `1` and `"1"` are different requests.
 */
import { createHash } from 'node:crypto';

/**
 * The authenticated caller, as a value safe to persist.
 *
 * The bearer token itself never reaches the database, the logs or a response;
 * only this digest of it does, and the digest is never returned to a client.
 */
export function identityHash(token: string): string {
  return sha256(`acp-auth:${token}`);
}

/** SHA-256 over the canonical form of a parsed JSON document. */
export function requestFingerprint(body: unknown): string {
  return sha256(canonicalize(body));
}

/**
 * Deterministic JSON canonicalization, in the spirit of RFC 8785 and limited to
 * what `JSON.parse` can produce - no dependency for what is twenty lines.
 *
 * Object keys are sorted by UTF-16 code unit, exactly as `Array.prototype.sort`
 * orders them, so two orderings of the same object canonicalize identically.
 * Numbers go through `JSON.stringify`, which already normalises `1.0`, `1e2`
 * and `100` to one shortest round-trip form.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` cannot come from JSON.parse, but a caller could hand us an
      // object literal; dropping those keys keeps "absent" and "absent" equal.
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  // Strings, numbers and booleans. `JSON.stringify` never returns undefined
  // for these, and the types stay distinct because their encodings do.
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
