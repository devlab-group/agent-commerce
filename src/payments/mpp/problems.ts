/**
 * Map MPP payment errors to the Problem Details types in
 * `draft-httpauth-payment-01`. This module has no optional peer imports, so
 * the main HTTP route can use it.
 */

export const MPP_PROBLEM_BASE_URI = 'https://paymentauth.org/problems/';

export type MppProblemType =
  | 'payment-required'
  | 'malformed-credential'
  | 'invalid-challenge'
  | 'payment-expired'
  | 'verification-failed'
  | 'internal-payment-error';

const TITLES: Readonly<Record<MppProblemType, string>> = {
  'payment-required': 'Payment Required',
  'malformed-credential': 'Malformed Credential',
  'invalid-challenge': 'Invalid Challenge',
  'payment-expired': 'Payment Expired',
  'verification-failed': 'Verification Failed',
  'internal-payment-error': 'Internal Payment Error',
};

// Map known MPP refusal reasons to problem types; other reasons use
// `verification-failed`. A Map keeps facilitator text out of Object.prototype
const REASON_TYPES: ReadonlyMap<string, MppProblemType> = new Map([
  ['malformed_credential', 'malformed-credential'],
  ['invalid_payload', 'malformed-credential'],
  ['invalid_challenge', 'invalid-challenge'],
  ['challenge_not_issued', 'invalid-challenge'],
  ['wrong_realm', 'invalid-challenge'],
  ['wrong_resource', 'invalid-challenge'],
  ['challenge_already_used', 'invalid-challenge'],
  ['challenge_expired', 'payment-expired'],
  ['authorization_expired', 'payment-expired'],
]);

/** The Problem Details `type` URI and `title` for an MPP payment error */
export function mppProblem(
  code: string,
  httpStatus: number,
  reason?: string,
): { readonly type: string; readonly title: string } {
  const problem = problemType(code, httpStatus, reason);
  return { type: `${MPP_PROBLEM_BASE_URI}${problem}`, title: TITLES[problem] };
}

// Descriptions for MPP reasons and two x402 facilitator refusals
const REASON_DETAILS: ReadonlyMap<string, string> = new Map([
  ['wrong_provider', 'The challenge was issued for another payment method.'],
  ['missing_challenge', 'No challenge is available for this request.'],
  ['malformed_credential', 'The credential could not be decoded.'],
  ['invalid_payload', 'The credential payload does not match the expected format.'],
  ['invalid_challenge', 'The credential does not answer a valid challenge.'],
  ['challenge_not_issued', 'The challenge was not issued by this server or was altered.'],
  ['challenge_already_used', 'The challenge has already been used for a payment.'],
  ['challenge_expired', 'The challenge has expired.'],
  ['wrong_realm', 'The challenge was issued for another realm.'],
  ['wrong_resource', 'The challenge was issued for another resource.'],
  [
    'unsupported_method',
    'The challenge names a payment method or intent this server does not accept.',
  ],
  ['unsupported_credential', 'The credential type is not accepted for this challenge.'],
  ['body_digest_mismatch', 'The request body differs from the one the challenge was issued for.'],
  ['wrong_amount', 'The payment amount does not match the challenge.'],
  ['wrong_recipient', 'The payment recipient does not match the challenge.'],
  ['wrong_network', 'The payment uses a different network from the challenge.'],
  ['wrong_asset', 'The payment uses a different asset from the challenge.'],
  ['wrong_terms', 'The payment terms do not match the challenge.'],
  ['wrong_nonce', 'The authorization nonce is not derived from the challenge.'],
  ['invalid_signature', 'The authorization signature does not match the payer.'],
  ['source_mismatch', 'The credential source is not the account that signed the authorization.'],
  ['authorization_not_yet_valid', 'The authorization is not valid yet.'],
  ['authorization_expired', 'The authorization has expired.'],
  ['authorization_invalid', 'The authorization failed verification.'],
  ['settlement_rejected', 'The payment was refused before settlement.'],
  ['settlement_mismatch', 'The payment could not be matched to its settlement.'],
  ['invalid_exact_evm_insufficient_balance', 'The payer balance is too low for this payment.'],
  [
    'invalid_exact_evm_transaction_simulation_failed',
    'The transfer failed in simulation, so it was not submitted.',
  ],
]);

/** Return a sentence for a known reason, or quote an unknown reason */
export function mppProblemDetail(reason: string | undefined, fallback: string): string {
  if (reason === undefined) return fallback;
  return REASON_DETAILS.get(reason) ?? `The payment was refused: ${reason}.`;
}

function problemType(code: string, httpStatus: number, reason?: string): MppProblemType {
  if (code === 'PAYMENT_REQUIRED') return 'payment-required';
  if (httpStatus >= 500) return 'internal-payment-error';
  // A replayed credential reuses its challenge because the replay key
  // includes the challenge-derived nonce
  if (code === 'PAYMENT_REPLAYED') return 'invalid-challenge';
  return (reason !== undefined ? REASON_TYPES.get(reason) : undefined) ?? 'verification-failed';
}
