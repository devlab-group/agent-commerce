/**
 * Exact conversion from display amounts ("0.01" USDC) to the integer base
 * units x402 and EIP-3009 carry ("10000" at 6 decimals).
 *
 * It never goes through a JS `number`, which cannot represent most decimal
 * fractions. viem's `parseUnits` is not used either: it silently rounds excess
 * fractional digits, and "0.0000001" against a 6-decimal asset is a
 * configuration bug that must be refused, not rounded. The reverse direction
 * is viem's `formatUnits`, which is exact.
 */
import { CommerceError } from '../../core';

const DECIMAL_STRING_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Parses a canonical decimal display amount (e.g. "0.01") into base units
 * for an asset with the given number of decimals, without floating point.
 *
 * Throws `CommerceError('PAYMENT_INVALID')` if the string is not a plain
 * non-negative decimal, or if it carries more fractional digits than the
 * asset supports.
 */
export function parseCanonicalAmount(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new CommerceError('INTERNAL_ERROR', `Invalid asset decimals: ${decimals}`);
  }
  if (!DECIMAL_STRING_PATTERN.test(amount)) {
    throw new CommerceError(
      'PAYMENT_INVALID',
      `Amount "${amount}" is not a valid non-negative decimal string`,
      {
        details: { amount },
      },
    );
  }

  const [integerPart = '0', fractionPart = ''] = amount.split('.');

  if (fractionPart.length > decimals) {
    throw new CommerceError(
      'PAYMENT_INVALID',
      `Amount "${amount}" has more precision than the asset supports (${decimals} decimals)`,
      { details: { amount, assetDecimals: decimals } },
    );
  }

  const paddedFraction = fractionPart.padEnd(decimals, '0');
  const combined = `${integerPart}${paddedFraction}`;
  return BigInt(combined);
}
