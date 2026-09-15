/**
 * Every failure the AP2 verifier can report.
 *
 * `CommerceError.message` reaches the client, and a mandate carries the
 * buyer's purchase and often personal data, so messages are fixed phrases from
 * the list below. The machine-readable code goes in `details.reason` and the
 * original exception on `cause`, which is never serialised.
 *
 * Three codes: AUTHORIZATION_INVALID when the buyer's mandate is bad,
 * AUTHORIZATION_REPLAYED when it is good but spent, and
 * AUTHORIZATION_PROVIDER_UNAVAILABLE when our verifier never reached a
 * verdict. Blaming the buyer for our outage refuses a good mandate.
 */
import { CommerceError } from '../../core/index.js';

/**
 * Coarse on purpose: a client learns roughly where its mandate was refused,
 * not which check failed. Finer detail is an oracle for probing trust policy.
 */
export const AP2_REJECTION_REASONS = [
  'malformed_presentation',
  'untrusted_issuer',
  'unknown_key',
  'invalid_signature',
  'unsupported_algorithm',
  'invalid_claims',
  'expired',
  'wrong_audience',
  'unsupported_mandate_type',
  'checkout_binding_failed',
  'purchase_mismatch',
] as const;

export type Ap2RejectionReason = (typeof AP2_REJECTION_REASONS)[number];

const MESSAGES: Readonly<Record<Ap2RejectionReason, string>> = {
  malformed_presentation: 'The authorization is not a well-formed SD-JWT presentation.',
  untrusted_issuer: 'The mandate was issued by a party this merchant does not trust.',
  unknown_key: 'The mandate names a signing key this merchant does not trust.',
  invalid_signature: 'The mandate signature did not verify.',
  unsupported_algorithm: 'The mandate uses a signature or digest algorithm that is not accepted.',
  invalid_claims: 'The mandate is missing required claims or they are malformed.',
  expired: 'The mandate is expired or not yet valid.',
  wrong_audience: 'The mandate is addressed to a different audience.',
  unsupported_mandate_type: 'The mandate is not a closed Direct Checkout Mandate.',
  checkout_binding_failed: 'The merchant checkout document bound to the mandate did not verify.',
  purchase_mismatch: 'The mandate does not authorize this purchase.',
};

export interface Ap2ErrorContext {
  readonly requestId?: string;
  readonly resourceId?: string;
  readonly cause?: unknown;
}

/** The buyer's mandate is bad. Fail closed */
export function ap2Rejected(
  reason: Ap2RejectionReason,
  context: Ap2ErrorContext = {},
): CommerceError {
  return new CommerceError('AUTHORIZATION_INVALID', MESSAGES[reason], {
    details: { method: 'ap2', reason },
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(context.resourceId !== undefined ? { resourceId: context.resourceId } : {}),
    ...(context.cause !== undefined ? { cause: context.cause } : {}),
  });
}

/**
 * The mandate verified but has already been presented. A separate code from
 * a bad mandate: nothing is wrong with this proof except that it is spent
 */
export function ap2Replayed(state: string, context: Ap2ErrorContext = {}): CommerceError {
  return new CommerceError(
    'AUTHORIZATION_REPLAYED',
    'This mandate has already been presented and cannot authorize another purchase.',
    {
      details: { method: 'ap2', reason: 'replayed', state },
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(context.resourceId !== undefined ? { resourceId: context.resourceId } : {}),
    },
  );
}

/**
 * The check never ran (a configured key that will not import, say). Retryable,
 * and never recorded against the payer: the mandate may be perfectly good.
 */
export function ap2Unavailable(detail: string, context: Ap2ErrorContext = {}): CommerceError {
  return new CommerceError(
    'AUTHORIZATION_PROVIDER_UNAVAILABLE',
    'Authorization could not be verified right now. This is a merchant-side fault, not a problem with the presented mandate.',
    {
      details: { method: 'ap2', reason: 'verifier_unavailable', detail },
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(context.resourceId !== undefined ? { resourceId: context.resourceId } : {}),
      ...(context.cause !== undefined ? { cause: context.cause } : {}),
    },
  );
}
