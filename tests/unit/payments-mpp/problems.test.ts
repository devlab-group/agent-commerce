import { describe, expect, it } from 'vitest';
import { mppProblem, mppProblemDetail } from '../../../src/payments/mpp/problems';

const type = (name: string) => `https://paymentauth.org/problems/${name}`;

describe('mppProblem', () => {
  it.each([
    ['PAYMENT_INVALID', 402, 'malformed_credential', 'malformed-credential'],
    ['PAYMENT_INVALID', 402, 'invalid_payload', 'malformed-credential'],
    ['PAYMENT_INVALID', 402, 'challenge_not_issued', 'invalid-challenge'],
    ['PAYMENT_INVALID', 402, 'wrong_resource', 'invalid-challenge'],
    ['PAYMENT_INVALID', 402, 'challenge_already_used', 'invalid-challenge'],
    ['PAYMENT_REQUIRED', 402, undefined, 'payment-required'],
    ['PAYMENT_INVALID', 402, 'challenge_expired', 'payment-expired'],
    ['PAYMENT_INVALID', 402, 'authorization_expired', 'payment-expired'],
    ['PAYMENT_INVALID', 402, 'wrong_nonce', 'verification-failed'],
    ['PAYMENT_INVALID', 402, undefined, 'verification-failed'],
    ['PAYMENT_REPLAYED', 402, undefined, 'invalid-challenge'],
    ['PAYMENT_REPLAYED', 409, undefined, 'invalid-challenge'],
    ['PAYMENT_SETTLEMENT_FAILED', 402, 'insufficient_funds', 'verification-failed'],
    ['PAYMENT_SETTLEMENT_FAILED', 502, undefined, 'internal-payment-error'],
    ['PAYMENT_PROVIDER_UNAVAILABLE', 503, undefined, 'internal-payment-error'],
    ['INPUT_INVALID', 400, 'payment_identifier_invalid', 'bad-request'],
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

  it.each([
    'payment_identifier_conflict',
    'payment_identifier_in_flight',
    'payment_identifier_unresolved',
  ])('answers the retry-key 409 %s with about:blank, not invalid-challenge', (reason) => {
    expect(mppProblem('PAYMENT_REPLAYED', 409, reason)).toEqual({
      type: 'about:blank',
      title: 'Conflict',
    });
  });

  it('titles a bad retry key Bad Request', () => {
    expect(mppProblem('INPUT_INVALID', 400, 'payment_identifier_invalid').title).toBe(
      'Bad Request',
    );
  });

  it('titles the unpaid challenge Payment Required', () => {
    expect(mppProblem('PAYMENT_REQUIRED', 402).title).toBe('Payment Required');
  });
});

describe('mppProblemDetail', () => {
  it('describes a known reason in a sentence', () => {
    expect(mppProblemDetail('wrong_nonce', 'fallback')).toBe(
      'The authorization nonce is not derived from the challenge.',
    );
  });

  it.each([
    [
      'payment_identifier_invalid',
      'The Idempotency-Key header must be 1 to 255 printable ASCII characters.',
    ],
    [
      'payment_identifier_conflict',
      'The Idempotency-Key belongs to a request with other input or another payer.',
    ],
    ['payment_identifier_in_flight', 'A request with this Idempotency-Key is still in progress.'],
    [
      'payment_identifier_unresolved',
      'The earlier request with this Idempotency-Key may have been charged and has no stored response.',
    ],
  ])('describes the retry-key reason %s', (reason, sentence) => {
    expect(mppProblemDetail(reason, 'fallback')).toBe(sentence);
  });

  it('quotes a reason it has no sentence for, without reading Object.prototype', () => {
    expect(mppProblemDetail('insufficient_funds', 'fallback')).toBe(
      'The payment was refused: insufficient_funds.',
    );
    expect(mppProblemDetail('constructor', 'fallback')).toBe(
      'The payment was refused: constructor.',
    );
  });

  it('keeps the error message when there is no reason', () => {
    expect(mppProblemDetail(undefined, 'Settlement could not be confirmed')).toBe(
      'Settlement could not be confirmed',
    );
  });
});
