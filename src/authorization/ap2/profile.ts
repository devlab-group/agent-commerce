/**
 * Binds a verified mandate to the purchase in front of us.
 *
 * A perfect mandate authorises exactly one purchase; without this comparison a
 * mandate approved for a $0.01 report would settle a $500 one.
 *
 * Everything is compared against the ALREADY RESOLVED request. Nothing is
 * taken from the mandate and used to shape the purchase, which would invert
 * the control.
 */
import canonicalize from 'canonicalize';
import type { AuthorizationVerificationContext } from '../../core/index.js';
import { AP2_CHECKOUT_PROFILE } from './constants.js';
import { type Ap2ErrorContext, ap2Rejected } from './errors.js';
import type { VerifiedCheckoutMandate } from './types.js';

/**
 * All required. Absent is a mismatch, never a skipped check: a mandate that
 * will not say which resource or how much authorises nothing in particular.
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
 * without it, one mandate for `translate` would authorise any translation.
 *
 * `canonicalize` rather than a sorted-key `JSON.stringify`, which differs
 * exactly where it matters. The merchant's signer computes this same digest,
 * probably in another language, and the two agree only if both follow RFC
 * 8785's number formatting and UTF-16 key ordering.
 *
 * The caller passes what the backend will receive: validated, reserved fields
 * stripped, no request id or transport metadata (the buyer could not have
 * known those when they approved).
 */
export async function computeInputHash(input: unknown): Promise<string> {
  const canonical = canonicalize(input ?? {});
  // undefined means JSON cannot represent it. Input has already passed schema
  // validation, so this is something exotic getting past it, not a buyer error.
  if (canonical === undefined) {
    throw new TypeError('resource input is not canonicalizable JSON');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Buffer.from(digest).toString('base64url');
}

/** What the mandate turned out to authorise, once it matched */
export interface BoundPurchase {
  readonly resourceId: string;
  readonly amount: string;
  readonly currency: string;
  readonly paymentMethod: string;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
): Promise<BoundPurchase> {
  const profile = asRecord(mandate.checkoutClaims['agent_commerce']);
  if (profile === undefined) throw ap2Rejected('purchase_mismatch', errorContext);

  for (const claim of REQUIRED_PROFILE_CLAIMS) {
    const value = profile[claim];
    if (typeof value !== 'string' || value.length === 0) {
      throw ap2Rejected('purchase_mismatch', errorContext);
    }
  }

  const requirement = context.requirement;
  const expectedInputHash = await computeInputHash(context.input);

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

  return {
    resourceId: profile['resource_id'] as string,
    amount: profile['amount'] as string,
    currency: profile['currency'] as string,
    paymentMethod: profile['payment_method'] as string,
  };
}
