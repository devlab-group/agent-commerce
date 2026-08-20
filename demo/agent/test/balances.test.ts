import { describe, expect, it } from 'vitest';
import { formatAssetAmount, parseAssetAmount } from '../src/balances.js';

describe('formatAssetAmount / parseAssetAmount', () => {
  it('formats base units to a decimal string using the asset decimals', () => {
    expect(formatAssetAmount(10_000n, 6)).toBe('0.01');
    expect(formatAssetAmount(1_000_000n, 6)).toBe('1');
  });

  it('round-trips a canonical decimal amount through parse -> format', () => {
    expect(parseAssetAmount('0.01', 6)).toBe(10_000n);
    expect(formatAssetAmount(parseAssetAmount('0.01', 6), 6)).toBe('0.01');
  });
});
