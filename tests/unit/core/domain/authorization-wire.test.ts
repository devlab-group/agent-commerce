/**
 * The generic authorization carrier, at the one place every surface shares.
 *
 * MCP and A2A both call `extractReservedInputFields` and HTTP calls
 * `parseAuthorizationHeader`. The envelope rules therefore only have to be
 * right once, which is why the extraction lives in core rather than being
 * written out per adapter.
 */
import { describe, expect, it } from 'vitest';
import type { CommerceResource, PaymentRequiredOutcome } from '../../../../src/core/index.js';
import {
  AUTHORIZATION_INPUT_FIELD,
  type CommerceError,
  extractReservedInputFields,
  isCommerceError,
  MAX_AUTHORIZATION_HEADER_BYTES,
  PAYMENT_INPUT_FIELD,
  parseAuthorizationHeader,
  parseAuthorizationSubmission,
  RESERVED_INPUT_FIELDS,
  toPaymentRequiredEnvelope,
} from '../../../../src/core/index.js';

const PROOF = 'eyJhbGciOiJFUzI1NiJ9.mandate~disclosure~';

const paidResource: CommerceResource = {
  id: 'premium_report',
  name: 'Premium Report',
  handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
  pricing: { type: 'fixed', amount: '0.10', currency: 'USDC' },
  exposedVia: ['http', 'mcp', 'a2a'],
  paymentMethods: ['x402'],
};

const freeResource: CommerceResource = {
  ...paidResource,
  id: 'free_report',
  pricing: { type: 'free' },
  paymentMethods: [],
};

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isCommerceError(error) ? error.code : `unexpected: ${String(error)}`;
  }
  return 'no error thrown';
}

describe('reserved input fields', () => {
  it('names both gateway-reserved fields in one list', () => {
    expect(RESERVED_INPUT_FIELDS).toEqual([PAYMENT_INPUT_FIELD, AUTHORIZATION_INPUT_FIELD]);
  });
});

describe('parseAuthorizationSubmission', () => {
  it('accepts a well-formed envelope', () => {
    expect(parseAuthorizationSubmission({ method: 'ap2', payload: PROOF })).toEqual({
      method: 'ap2',
      payload: PROOF,
    });
  });

  it('preserves the payload byte for byte', () => {
    // Providers hash this string to derive a replay identity, so any
    // normalisation here would give the same proof two identities.
    const awkward = ' a~b.c \n';
    expect(parseAuthorizationSubmission({ method: 'ap2', payload: awkward })?.payload).toBe(
      awkward,
    );
  });

  it.each([
    ['absent', undefined],
    ['null', null],
  ])('treats %s as no authorization at all', (_label, value) => {
    expect(parseAuthorizationSubmission(value)).toBeUndefined();
  });

  it.each([
    ['a bare string', 'just-the-proof'],
    ['an array', [{ method: 'ap2', payload: PROOF }]],
    ['a number', 42],
    ['an unknown method', { method: 'ap3', payload: PROOF }],
    ['a missing method', { payload: PROOF }],
    ['a non-string payload', { method: 'ap2', payload: { jwt: PROOF } }],
    ['an empty payload', { method: 'ap2', payload: '' }],
    ['a missing payload', { method: 'ap2' }],
  ])('rejects %s as AUTHORIZATION_INVALID', (_label, value) => {
    expect(codeOf(() => parseAuthorizationSubmission(value))).toBe('AUTHORIZATION_INVALID');
  });

  it('never reports an authorization failure as a payment failure', () => {
    // The distinction is the point of the feature: a buyer whose mandate is
    // malformed has not paid wrongly, and must not be told to pay again.
    try {
      parseAuthorizationSubmission({ method: 'ap2' });
      expect.unreachable();
    } catch (error) {
      const commerce = error as CommerceError;
      expect(commerce.code).not.toMatch(/^PAYMENT_/);
      expect(commerce.httpStatus).toBe(403);
      expect(commerce.retryable).toBe(false);
    }
  });

  it('carries the request id so the failure correlates with the rest of the flow', () => {
    try {
      parseAuthorizationSubmission({ method: 'ap2' }, 'req-7');
      expect.unreachable();
    } catch (error) {
      expect((error as CommerceError).requestId).toBe('req-7');
    }
  });
});

describe('parseAuthorizationHeader', () => {
  it('decodes a base64url JSON envelope', () => {
    expect(parseAuthorizationHeader(encodeHeader({ method: 'ap2', payload: PROOF }))).toEqual({
      method: 'ap2',
      payload: PROOF,
    });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('treats an %s header as no authorization', (_label, value) => {
    expect(parseAuthorizationHeader(value)).toBeUndefined();
  });

  it('reads the first value when a client sends the header twice', () => {
    const first = encodeHeader({ method: 'ap2', payload: PROOF });
    const second = encodeHeader({ method: 'ap2', payload: 'other' });
    expect(parseAuthorizationHeader([first, second])?.payload).toBe(PROOF);
  });

  it.each([
    ['not base64url', '!!!not base64!!!'],
    ['base64url of something that is not JSON', Buffer.from('nope').toString('base64url')],
    ['base64url of a valid JSON non-envelope', encodeHeader(['ap2', PROOF])],
  ])('rejects a header that is %s', (_label, value) => {
    expect(codeOf(() => parseAuthorizationHeader(value))).toBe('AUTHORIZATION_INVALID');
  });

  it('rejects an oversized header and names the limit', () => {
    const oversized = 'a'.repeat(MAX_AUTHORIZATION_HEADER_BYTES + 1);
    try {
      parseAuthorizationHeader(oversized);
      expect.unreachable();
    } catch (error) {
      const commerce = error as CommerceError;
      expect(commerce.code).toBe('AUTHORIZATION_INVALID');
      expect(commerce.message).toContain(String(MAX_AUTHORIZATION_HEADER_BYTES));
    }
  });

  it('accepts a header exactly at the limit', () => {
    // base64url expands by 4/3, so the payload that fits is the limit scaled
    // down, minus room for the JSON envelope around it.
    const payload = 'x'.repeat(Math.floor((MAX_AUTHORIZATION_HEADER_BYTES * 3) / 4) - 64);
    const header = encodeHeader({ method: 'ap2', payload });
    expect(header.length).toBeLessThanOrEqual(MAX_AUTHORIZATION_HEADER_BYTES);
    expect(parseAuthorizationHeader(header)?.payload).toBe(payload);
  });

  it('does not echo the caller input back in the message', () => {
    // A JSON parse error quotes what it choked on; relaying that would put
    // attacker-chosen bytes into our own error response.
    const probe = '<script>alert(1)</script>';
    try {
      parseAuthorizationHeader(Buffer.from(probe).toString('base64url'));
      expect.unreachable();
    } catch (error) {
      expect((error as CommerceError).message).not.toContain(probe);
    }
  });
});

describe('extractReservedInputFields', () => {
  it('leaves ordinary input completely alone', () => {
    const result = extractReservedInputFields({ city: 'Berlin' }, paidResource);
    expect(result).toEqual({ input: { city: 'Berlin' } });
    expect(result.payment).toBeUndefined();
    expect(result.authorization).toBeUndefined();
  });

  it('lifts a payment proof out of the input and takes the rail from the resource', () => {
    const result = extractReservedInputFields(
      { city: 'Berlin', [PAYMENT_INPUT_FIELD]: 'proof-abc' },
      paidResource,
    );
    expect(result.input).toEqual({ city: 'Berlin' });
    expect(result.payment).toEqual({ method: 'x402', payload: 'proof-abc' });
  });

  it.each([
    ['the resource has no payment rail', freeResource],
    ['the resource is unknown', undefined],
  ])('drops a payment proof when %s rather than inventing a rail', (_label, resource) => {
    const result = extractReservedInputFields(
      { city: 'Berlin', [PAYMENT_INPUT_FIELD]: 'proof-abc' },
      resource,
    );
    expect(result.input).toEqual({ city: 'Berlin' });
    expect(result.payment).toBeUndefined();
  });

  it('lifts an authorization envelope out of the input', () => {
    const result = extractReservedInputFields(
      { city: 'Berlin', [AUTHORIZATION_INPUT_FIELD]: { method: 'ap2', payload: PROOF } },
      paidResource,
    );
    expect(result.input).toEqual({ city: 'Berlin' });
    expect(result.authorization).toEqual({ method: 'ap2', payload: PROOF });
  });

  it('strips the reserved field even when the envelope is unusable', () => {
    // An adapter that forwarded the raw field would fail schema validation
    // with INPUT_INVALID, hiding the real reason from the caller.
    expect(
      codeOf(() =>
        extractReservedInputFields(
          { city: 'Berlin', [AUTHORIZATION_INPUT_FIELD]: 'bare-string' },
          paidResource,
        ),
      ),
    ).toBe('AUTHORIZATION_INVALID');
  });

  it('carries both reserved fields at once', () => {
    const result = extractReservedInputFields(
      {
        city: 'Berlin',
        [PAYMENT_INPUT_FIELD]: 'proof-abc',
        [AUTHORIZATION_INPUT_FIELD]: { method: 'ap2', payload: PROOF },
      },
      paidResource,
    );
    expect(result.input).toEqual({ city: 'Berlin' });
    expect(result.payment).toEqual({ method: 'x402', payload: 'proof-abc' });
    expect(result.authorization).toEqual({ method: 'ap2', payload: PROOF });
  });

  it('keeps an authorization even for a resource that requires none', () => {
    // Whether one is required is the pipeline's decision, made against the
    // resource policy. The carrier does not get to pre-empt it.
    const result = extractReservedInputFields(
      { [AUTHORIZATION_INPUT_FIELD]: { method: 'ap2', payload: PROOF } },
      freeResource,
    );
    expect(result.authorization).toEqual({ method: 'ap2', payload: PROOF });
  });
});

describe('payment-required envelope', () => {
  const outcome: PaymentRequiredOutcome = {
    kind: 'payment-required',
    requestId: 'req-1',
    resourceId: 'premium_report',
    requirement: {
      id: 'pr-1',
      requestId: 'req-1',
      resourceId: 'premium_report',
      provider: 'x402',
      amount: '0.10',
      currency: 'USDC',
      destination: '0xmerchant',
      challenge: { provider: 'x402', version: '2', accepts: [] },
    },
  };

  it('is byte-identical to before when the resource requires no authorization', () => {
    expect(toPaymentRequiredEnvelope(outcome)).not.toHaveProperty('authorization');
  });

  it('omits the field for an empty requirement list rather than advertising nothing', () => {
    expect(toPaymentRequiredEnvelope({ ...outcome, authorization: [] })).not.toHaveProperty(
      'authorization',
    );
  });

  it('advertises the requirement so a buyer learns before paying that payment alone will not do', () => {
    const envelope = toPaymentRequiredEnvelope({
      ...outcome,
      authorization: [
        { method: 'ap2', version: '0.2.0', profile: 'https://example.test/checkout/v1' },
      ],
    });
    expect(envelope.authorization).toEqual({
      required: [{ method: 'ap2', version: '0.2.0', profile: 'https://example.test/checkout/v1' }],
    });
    // Still a 402 challenge in every other respect.
    expect(envelope.code).toBe('PAYMENT_REQUIRED');
    expect(envelope.payment.amount).toBe('0.10');
  });
});
