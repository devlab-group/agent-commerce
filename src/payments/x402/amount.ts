/**
 * Deterministic decimal <-> base-unit conversion.
 *
 * `DecimalAmount` (see src/core) is a decimal string in
 * *display* units ("0.01" USDC). x402 / EIP-3009 need base units (integer
 * string, e.g. "10000" for 0.01 USDC at 6 decimals). This conversion must
 * never go through a JS `number` — floating point cannot represent most
 * decimal fractions exactly, and a silently-rounded payment amount is a
 * security bug in a payment provider.
 *
 * viem's own `parseUnits` rounds silently when given more fractional digits
 * than `decimals` supports; we need a hard error instead (a merchant asking
 * for "0.0000001" against a 6-decimal asset is a configuration bug, not a
 * roundable amount), so this module implements its own strict parser.
 */
import { CommerceError } from '../../core/index.js';

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
  // Strip leading zeros so BigInt doesn't choke on e.g. "007" — BigInt() is
  // fine with leading zeros in decimal strings, but normalise defensively.
  return BigInt(combined);
}

/**
 * Formats base units back into a canonical decimal display string.
 *
 * Exact (no rounding is possible going from integer base units to a wider
 * decimal representation), so this is safe to implement directly.
 */
export function formatCanonicalAmount(baseUnits: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new CommerceError('INTERNAL_ERROR', `Invalid asset decimals: ${decimals}`);
  }
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const digits = abs.toString().padStart(decimals + 1, '0');
  const integerPart = digits.slice(0, digits.length - decimals) || '0';
  const fractionPart = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fractionPart.length > 0
    ? `${sign}${integerPart}.${fractionPart}`
    : `${sign}${integerPart}`;
}
