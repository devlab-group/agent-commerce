/**
 * Stage two: the merchant checkout JWT the mandate binds.
 *
 * AP2 leaves this document's payload outside its own scope, so all the mandate
 * guarantees is `checkout_hash`: a digest of the exact compact JWT the buyer
 * approved. Two things have to hold, and neither substitutes for the other.
 *
 * The hash proves the buyer approved *this* document. The signature proves the
 * merchant issued it. Checking only the hash accepts any document a buyer
 * chose to approve, including one they wrote themselves. Checking only the
 * signature accepts a genuine merchant document this mandate never covered.
 */
import { type JWTVerifyOptions, jwtVerify } from 'jose';
import type { Clock } from '../../core/index.js';
import { AP2_SIGNING_ALGORITHM } from './constants.js';
import { type Ap2ErrorContext, ap2Rejected } from './errors.js';
import type { TrustStore } from './trust.js';

export interface VerifiedCheckoutJwt {
  readonly issuer: string;
  readonly jwtId: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

function decodeSegment(jwt: string, index: 0 | 1): Record<string, unknown> | undefined {
  const segment = jwt.split('.')[index];
  if (segment === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies the checkout JWT carried by an already-verified mandate.
 *
 * `mandateClaims` must come from a mandate whose own signature has been
 * checked, because `checkout_hash` is only worth anything if the issuer signed
 * it.
 */
export async function verifyCheckoutJwt(
  mandateClaims: Readonly<Record<string, unknown>>,
  deps: { readonly trust: TrustStore; readonly clock: Clock; readonly clockSkewSeconds: number },
  context: Ap2ErrorContext,
): Promise<VerifiedCheckoutJwt> {
  const compact = mandateClaims['checkout_jwt'];
  const expectedHash = mandateClaims['checkout_hash'];
  if (typeof compact !== 'string' || compact.length === 0) {
    throw ap2Rejected('invalid_claims', context);
  }
  if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
    throw ap2Rejected('invalid_claims', context);
  }

  await requireMatchingHash(compact, expectedHash, context);

  const header = decodeSegment(compact, 0);
  const unverifiedPayload = decodeSegment(compact, 1);
  if (header === undefined || unverifiedPayload === undefined) {
    throw ap2Rejected('checkout_binding_failed', context);
  }

  const { issuer, key } = await deps.trust.resolve(
    unverifiedPayload['iss'],
    header['kid'],
    context,
  );

  const options: JWTVerifyOptions = {
    algorithms: [AP2_SIGNING_ALGORITHM],
    issuer: issuer.issuer,
    audience: issuer.audience,
    clockTolerance: deps.clockSkewSeconds,
    currentDate: deps.clock.now(),
  };

  let claims: Record<string, unknown>;
  try {
    const result = await jwtVerify(compact, key, options);
    claims = result.payload as Record<string, unknown>;
  } catch (cause) {
    throw ap2Rejected('checkout_binding_failed', { ...context, cause });
  }

  const exp = claims['exp'];
  const iat = claims['iat'];
  const jti = claims['jti'];
  // Same reasoning as the mandate's own freshness check: jose validates a time
  // claim only when it is present, so requiring them is this file's job.
  if (typeof exp !== 'number' || typeof iat !== 'number') {
    throw ap2Rejected('invalid_claims', context);
  }
  // `jti` is what a later settlement is recorded against, so a checkout
  // document without one cannot be told apart from another.
  if (typeof jti !== 'string' || jti.length === 0) {
    throw ap2Rejected('invalid_claims', context);
  }
  const nowSeconds = Math.floor(deps.clock.now().getTime() / 1000);
  if (iat > nowSeconds + deps.clockSkewSeconds) throw ap2Rejected('expired', context);

  return { issuer: issuer.issuer, jwtId: jti, claims };
}

/**
 * Recomputes the digest over the exact compact string the mandate carried.
 *
 * Hashed as the bytes that arrived, never re-encoded from parsed claims. Two
 * JSON serialisations of one payload differ in whitespace and key order, so
 * they differ in digest, and every valid mandate would fail. Normalising first
 * would be worse: it hashes a document other than the one being verified.
 */
async function requireMatchingHash(
  compact: string,
  expected: string,
  context: Ap2ErrorContext,
): Promise<void> {
  const digest = await crypto.subtle.digest(
    // sha-256 only. The mandate's `_sd_alg` has already been pinned to it by
    // the time this runs, so there is no second algorithm to dispatch on.
    'SHA-256',
    new TextEncoder().encode(compact),
  );
  const actual = Buffer.from(digest).toString('base64url');
  // A plain comparison: both sides are public values an attacker holding the
  // presentation already knows, so there is no secret for timing to leak.
  if (actual !== expected) throw ap2Rejected('checkout_binding_failed', context);
}
