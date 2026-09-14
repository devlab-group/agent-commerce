/**
 * Every failure the AP2 verifier can report, and the rule for reporting it.
 *
 * `CommerceError.message` reaches the client over HTTP, MCP and A2A, so
 * nothing derived from the presentation may appear in one. A mandate carries
 * the buyer's approved purchase and, in the general case, personal data; an
 * error that quoted the claim it choked on would publish it to whoever sent
 * the request. The reason is a fixed phrase from the list below, the machine
 * -readable code goes in `details.reason`, and the underlying exception goes
 * on `cause`, which is never serialised.
 *
 * Two codes. A buyer presenting a bad mandate gets AUTHORIZATION_INVALID. Our
 * own verifier failing to work gets AUTHORIZATION_PROVIDER_UNAVAILABLE,
 * because no verdict was reached, and blaming the buyer for our outage is how
 * a perfectly good mandate ends up refused.
 */
import { CommerceError } from '../../core/index.js';

/**
 * Machine-readable rejection reasons.
 *
 * Coarse on purpose. A client learns that its mandate was refused and roughly
 * where, not which check failed at what offset. The finer version turns an
 * error response into an oracle for probing the trust policy.
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
};

export interface Ap2ErrorContext {
  readonly requestId?: string;
  readonly resourceId?: string;
  readonly cause?: unknown;
}

/** The buyer's mandate is bad. Fail closed, and say only which stage refused it. */
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
 * Our verifier could not reach a verdict.
 *
 * A configured key that will not import, or anything else that means the
 * check never ran. Retryable, and never recorded against the payer: the
 * mandate may well be perfectly good.
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
