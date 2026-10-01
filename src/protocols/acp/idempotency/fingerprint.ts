/**
 * Operation keys and request fingerprints for ACP idempotency.
 *
 * The fingerprint covers the parsed JSON value, not the raw bytes, so a retry
 * through another serializer (other key order, `1.0` for `1`, whitespace) is
 * a retry, not a 422 conflict. Array order, `null` versus an absent property,
 * and type still count: `1` and `"1"` are different requests.
 */
import { createHash } from 'node:crypto';

/**
 * The name the merchant sees for one checkout operation, hashed from the same
 * scope that claims the key locally (deployment, endpoint, caller's key), so
 * it stays the same across client and network retries, a gateway restart and
 * a credential rotation.
 *
 * The caller's key alone does not name an operation: ACP scopes it per
 * endpoint, so one client may send `Idempotency-Key: 1` to both create and
 * complete. Two clients that pick the same key share a derived key, as they
 * share a claim row; ACP makes key uniqueness the client's responsibility.
 */
export function operationKey(scope: {
  readonly deployment: string;
  readonly endpoint: string;
  readonly key: string;
}): string {
  return sha256(`acp-operation:${scope.deployment}:${scope.endpoint}:${scope.key}`);
}

/** SHA-256 over the canonical form of a parsed JSON document */
export function requestFingerprint(body: unknown): string {
  return sha256(canonicalize(body));
}

/**
 * Deterministic JSON canonicalization in the spirit of RFC 8785, limited to
 * what `JSON.parse` produces. Not the `canonicalize` package: that is an
 * optional peer (AP2), and this module is in the peer-free main entry.
 *
 * Object keys are sorted by UTF-16 code unit. Numbers go through
 * `JSON.stringify`, which writes each in its shortest round-trip form, so
 * `1.0` becomes `1` and `1e2` becomes `100`.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // JSON.parse never yields `undefined`, but an object literal could;
      // dropping such keys keeps them equal to absent ones
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  // Strings, numbers and booleans, whose encodings keep the types distinct
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
