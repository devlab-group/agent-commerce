/**
 * Map MPP payment errors to the Problem Details types in
 * `draft-httpauth-payment-01`. This module has no optional peer imports, so
 * the main HTTP route can use it.
 */

export const MPP_PROBLEM_BASE_URI = 'https://paymentauth.org/problems/';

export type MppProblemType =
  | 'malformed-credential'
  | 'invalid-challenge'
  | 'payment-expired'
  | 'verification-failed'
  | 'internal-payment-error';

const TITLES: Readonly<Record<MppProblemType, string>> = {
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

function problemType(code: string, httpStatus: number, reason?: string): MppProblemType {
  if (httpStatus >= 500) return 'internal-payment-error';
  // A replayed credential reuses its challenge because the replay key
  // includes the challenge-derived nonce
  if (code === 'PAYMENT_REPLAYED') return 'invalid-challenge';
  return (reason !== undefined ? REASON_TYPES.get(reason) : undefined) ?? 'verification-failed';
}
