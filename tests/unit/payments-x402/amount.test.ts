import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../src/core/index.js';
import { formatCanonicalAmount, parseCanonicalAmount } from '../../../src/payments/x402/amount.js';

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
    // 0.1 in float is 0.1000000000000000055511151231257827021181583404541015625 —
    // this must convert exactly, not via Number arithmetic.
    expect(parseCanonicalAmount('0.1', 6)).toBe(100_000n);
  });

  it('rejects a negative decimals count as an internal config error', () => {
    expect(() => parseCanonicalAmount('1', -1)).toThrow();
  });

  it('rejects a non-integer decimals count', () => {
    expect(() => parseCanonicalAmount('1', 1.5)).toThrow();
  });
});

describe('formatCanonicalAmount', () => {
  it('formats base units back to "0.01"', () => {
    expect(formatCanonicalAmount(10_000n, 6)).toBe('0.01');
  });

  it('formats whole units without a trailing decimal point', () => {
    expect(formatCanonicalAmount(1_000_000n, 6)).toBe('1');
  });

  it('formats the smallest unit', () => {
    expect(formatCanonicalAmount(1n, 6)).toBe('0.000001');
  });

  it('formats zero as "0"', () => {
    expect(formatCanonicalAmount(0n, 6)).toBe('0');
  });

  it('rejects a negative decimals count', () => {
    expect(() => formatCanonicalAmount(1n, -1)).toThrow();
  });

  it('formats a negative bigint with a leading minus sign', () => {
    // Not a realistic payment amount, but formatCanonicalAmount is a pure
    // function and must handle it correctly (defensive branch).
    expect(formatCanonicalAmount(-10_000n, 6)).toBe('-0.01');
  });

  it('round-trips parseCanonicalAmount for a range of values', () => {
    for (const amount of ['0.01', '1', '0.000001', '123.456789', '0']) {
      const baseUnits = parseCanonicalAmount(amount, 6);
      expect(formatCanonicalAmount(baseUnits, 6)).toBe(amount === '0' ? '0' : amount);
    }
  });
});
