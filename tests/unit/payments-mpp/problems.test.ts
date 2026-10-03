import { describe, expect, it } from 'vitest';
import { mppProblem } from '../../../src/payments/mpp/problems';

const type = (name: string) => `https://paymentauth.org/problems/${name}`;

describe('mppProblem', () => {
  it.each([
    ['PAYMENT_INVALID', 402, 'malformed_credential', 'malformed-credential'],
    ['PAYMENT_INVALID', 402, 'invalid_payload', 'malformed-credential'],
    ['PAYMENT_INVALID', 402, 'challenge_not_issued', 'invalid-challenge'],
    ['PAYMENT_INVALID', 402, 'wrong_resource', 'invalid-challenge'],
    ['PAYMENT_INVALID', 402, 'challenge_expired', 'payment-expired'],
    ['PAYMENT_INVALID', 402, 'authorization_expired', 'payment-expired'],
    ['PAYMENT_INVALID', 402, 'wrong_nonce', 'verification-failed'],
    ['PAYMENT_INVALID', 402, undefined, 'verification-failed'],
    ['PAYMENT_REPLAYED', 402, undefined, 'invalid-challenge'],
    ['PAYMENT_REPLAYED', 409, undefined, 'invalid-challenge'],
    ['PAYMENT_SETTLEMENT_FAILED', 402, 'insufficient_funds', 'verification-failed'],
    ['PAYMENT_SETTLEMENT_FAILED', 502, undefined, 'internal-payment-error'],
    ['PAYMENT_PROVIDER_UNAVAILABLE', 503, undefined, 'internal-payment-error'],
  ] as const)('%s %i %s -> %s', (code, status, reason, expected) => {
    expect(mppProblem(code, status, reason).type).toBe(type(expected));
  });

  it('never resolves a reason through Object.prototype', () => {
    // A facilitator's reason passes the provider's sanitizer and reaches here
    expect(mppProblem('PAYMENT_INVALID', 402, 'constructor')).toEqual({
      type: type('verification-failed'),
      title: 'Verification Failed',
    });
  });
});
