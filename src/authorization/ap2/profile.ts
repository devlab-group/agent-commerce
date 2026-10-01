/**
 * Binds a verified mandate to the purchase in front of us. Without this
 * comparison a mandate approved for a $0.01 report would settle a $500 one.
 *
 * Everything is compared against the ALREADY RESOLVED request. Nothing is
 * taken from the mandate to shape the purchase, which would invert the
 * control.
 */
import canonicalize from 'canonicalize';
import { type AuthorizationVerificationContext, CommerceError } from '../../core';
import { isRecord } from '../../core/is-record';
import { AP2_CHECKOUT_PROFILE } from './constants';
import { type Ap2ErrorContext, ap2Rejected } from './errors';
import { sha256 } from './sha256';
import type { VerifiedCheckoutMandate } from './types';

/**
 * All required. Absent is a mismatch, never a skipped check: a mandate that
 * will not say which resource or how much authorizes nothing in particular.
 */
const REQUIRED_PROFILE_CLAIMS = [
  'profile',
  'resource_id',
  'input_hash',
  'amount',
  'currency',
  'payment_method',
] as const;

/**
 * RFC 8785 (JCS) digest of the validated resource input.
 *
 * Binds a mandate to the exact request, not just to a resource and a price:
 * without it, one mandate for `translate` would authorize any translation.
 *
 * The merchant's signer, possibly in another language, agrees with this digest
 * only if it follows RFC 8785's number formatting and UTF-16 key ordering too;
 * sorting keys is not enough.
 *
 * The caller passes what the backend will receive: validated, reserved fields
 * stripped, no request id or transport metadata (the buyer could not have
 * known those when they approved).
 */
export function computeInputHash(input: unknown): string {
  const canonical = canonicalize(input ?? {});
  // undefined means JSON cannot represent the value (a function, say). On the
  // gateway path the input already passed schema validation, so this is not a
  // buyer error.
  if (canonical === undefined) {
    throw new CommerceError('INTERNAL_ERROR', 'resource input is not canonicalizable JSON');
  }
  return sha256(canonical).toString('base64url');
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;

// EIP-55 encodes an address checksum through letter casing, so lowercase and
// checksummed forms identify the same account. Other values compare exactly.
function sameCoordinate(declared: unknown, expected: string | undefined): boolean {
  if (typeof declared === 'string' && expected !== undefined) {
    if (EVM_ADDRESS.test(declared) && EVM_ADDRESS.test(expected)) {
      return declared.toLowerCase() === expected.toLowerCase();
    }
  }
  return declared === expected;
}

/**
 * Throws on the first mismatch with one coarse reason. Which field disagreed
 * is not reported: a caller able to ask about one field at a time can read a
 * mandate's contents out of the gateway by elimination.
 */
export async function bindMandateToPurchase(
  mandate: VerifiedCheckoutMandate,
  context: AuthorizationVerificationContext,
  errorContext: Ap2ErrorContext,
): Promise<void> {
  const profile = mandate.checkoutClaims['agent_commerce'];
  if (!isRecord(profile)) throw ap2Rejected('purchase_mismatch', errorContext);

  for (const claim of REQUIRED_PROFILE_CLAIMS) {
    const value = profile[claim];
    if (typeof value !== 'string' || value.length === 0) {
      throw ap2Rejected('purchase_mismatch', errorContext);
    }
  }

  const requirement = context.requirement;
  const expectedInputHash = computeInputHash(context.input);

  const mustMatch: readonly (readonly [string, unknown])[] = [
    ['profile', AP2_CHECKOUT_PROFILE],
    ['resource_id', context.resourceId],
    ['input_hash', expectedInputHash],
    // Decimal strings on both sides. Comparing numerically would make "0.10"
    // and "0.1" equal, and a mandate says what it says.
    ['amount', requirement.amount],
    ['currency', requirement.currency],
    ['payment_method', requirement.provider],
  ];

  for (const [claim, expected] of mustMatch) {
    if (profile[claim] !== expected) throw ap2Rejected('purchase_mismatch', errorContext);
  }

  // Checked whenever EITHER side names one, which is the fail-closed reading.
  // A mandate silent about the chain must not unlock a mainnet settlement, and
  // one naming a chain the requirement lacks was approved for another rail.
  for (const [claim, expected] of [
    ['destination', requirement.destination],
    ['network', requirement.network],
    ['asset', requirement.asset],
  ] as const) {
    const declared = profile[claim];
    if (declared === undefined && expected === undefined) continue;
    if (!sameCoordinate(declared, expected)) throw ap2Rejected('purchase_mismatch', errorContext);
  }
}
