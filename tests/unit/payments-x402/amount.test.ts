import { formatUnits } from 'viem';
import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../src/core';
import { parseCanonicalAmount } from '../../../src/payments/x402/amount';

describe('parseCanonicalAmount', () => {
  it('converts "0.01" at 6 decimals to 10000n', () => {
    expect(parseCanonicalAmount('0.01', 6)).toBe(10_000n);
  });

  it('converts "1" at 6 decimals to 1000000n', () => {
    expect(parseCanonicalAmount('1', 6)).toBe(1_000_000n);
  });

  it('converts "0.000001" at 6 decimals to 1n (smallest unit)', () => {
    expect(parseCanonicalAmount('0.000001', 6)).toBe(1n);
  });

  it('converts "0" at 6 decimals to 0n', () => {
    expect(parseCanonicalAmount('0', 6)).toBe(0n);
  });

  it('converts a whole number with 0 decimals', () => {
    expect(parseCanonicalAmount('42', 0)).toBe(42n);
  });

  it('rejects a value with more precision than the asset supports', () => {
    expect(() => parseCanonicalAmount('0.0000001', 6)).toThrow();
    try {
      parseCanonicalAmount('0.0000001', 6);
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCommerceError(err)).toBe(true);
      if (isCommerceError(err)) expect(err.code).toBe('PAYMENT_INVALID');
    }
  });

  it('rejects non-numeric strings', () => {
    expect(() => parseCanonicalAmount('abc', 6)).toThrow();
  });

  it('rejects negative amounts', () => {
    expect(() => parseCanonicalAmount('-1', 6)).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => parseCanonicalAmount('', 6)).toThrow();
  });

  it('rejects a value with a bare decimal point', () => {
    expect(() => parseCanonicalAmount('1.', 6)).toThrow();
  });

  it('never produces a floating point rounding artifact (0.1 + 0.2 style bug)', () => {
    // 0.1 as a float is 0.1000000000000000055511151231257827021181583404541015625,
    // so this must convert exactly, not through Number arithmetic
    expect(parseCanonicalAmount('0.1', 6)).toBe(100_000n);
  });

  it('rejects a negative decimals count as an internal config error', () => {
    expect(() => parseCanonicalAmount('1', -1)).toThrow();
  });

  it('rejects a non-integer decimals count', () => {
    expect(() => parseCanonicalAmount('1', 1.5)).toThrow();
  });
});

describe('parseCanonicalAmount and viem formatUnits', () => {
  it('round-trip exactly, as the provider relies on', () => {
    for (const amount of ['0.01', '1', '0.000001', '123.456789', '0']) {
      expect(formatUnits(parseCanonicalAmount(amount, 6), 6)).toBe(amount);
    }
  });
});
