// The `Idempotency-Key` that names a paid operation to the merchant
import { createHash } from 'node:crypto';

export interface PaidOperation {
  /** `merchant.publicBaseUrl`, which outlives credential rotation */
  readonly deployment: string;
  readonly resourceId: string;
  readonly replayKey: string;
  /** `inputDigest` of the validated input */
  readonly inputDigest: string | undefined;
  /** Client retry credential; only its hash enters the payment identity */
  readonly clientKey?: string;
  readonly payer?: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Derive a merchant operation key, or return `undefined` without an input digest.
 *
 * Use the hash of `clientKey` with `payer` when both are nonempty; otherwise
 * use `replayKey`. The client key keeps the same identity across proof changes;
 * the payer distinguishes buyers sharing that key. The input digest separates
 * bodies when a rejected proof is retried. Serialize fields as a JSON array to
 * keep delimiters in URLs or resource IDs within their fields. Format changes
 * alter derived keys and can break merchant deduplication.
 */
export function paidOperationKey(operation: PaidOperation): string | undefined {
  const { deployment, resourceId, replayKey, inputDigest: digest, clientKey, payer } = operation;
  if (digest === undefined) return undefined;
  const identity = clientKey && payer ? `retry:${sha256Hex(clientKey)}:${payer}` : replayKey;
  return sha256Hex(JSON.stringify(['paid-operation', deployment, resourceId, identity, digest]));
}
