/**
 * Stage two: the merchant checkout JWT the mandate binds.
 *
 * Two things have to hold. The hash proves the buyer approved *this* document;
 * the signature proves the merchant issued it. Hash alone accepts a document
 * the buyer wrote themselves; signature alone accepts a genuine merchant
 * document this mandate never covered.
 */
import { decodeJwt, decodeProtectedHeader, type JWTVerifyOptions, jwtVerify } from 'jose';
import type { Clock } from '../../core';
import { AP2_SIGNING_ALGORITHM } from './constants';
import { type Ap2ErrorContext, ap2Rejected } from './errors';
import { sha256 } from './sha256';
import type { TrustStore } from './trust';

export interface VerifiedCheckoutJwt {
  readonly issuer: string;
  readonly jwtId: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

/**
 * `mandateClaims` must come from an already-verified mandate: `checkout_hash`
 * is worth nothing unless the issuer signed it
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

  requireMatchingHash(compact, expectedHash, context);

  // Unverified, and read only to pick which configured key to try
  let header: ReturnType<typeof decodeProtectedHeader>;
  let unverifiedPayload: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(compact);
    unverifiedPayload = decodeJwt(compact);
  } catch (cause) {
    throw ap2Rejected('checkout_binding_failed', { ...context, cause });
  }

  const { issuer, key } = await deps.trust.resolve(unverifiedPayload.iss, header.kid, context);

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
  // jose validates a time claim only when present, so requiring them is ours
  if (typeof exp !== 'number' || typeof iat !== 'number') {
    throw ap2Rejected('invalid_claims', context);
  }
  // `jti` is what replay defense and the receipt record, so it is required
  if (typeof jti !== 'string' || jti.length === 0) {
    throw ap2Rejected('invalid_claims', context);
  }
  const nowSeconds = Math.floor(deps.clock.now().getTime() / 1000);
  if (iat > nowSeconds + deps.clockSkewSeconds) throw ap2Rejected('expired', context);

  return { issuer: issuer.issuer, jwtId: jti, claims };
}

/**
 * Hashes the compact JWT as it arrived. Re-encoding the parsed claims would
 * hash a different document from the one being verified.
 */
function requireMatchingHash(compact: string, expected: string, context: Ap2ErrorContext): void {
  // sha-256 only: `_sd_alg` was already pinned to it upstream
  const actual = sha256(compact).toString('base64url');
  // Plain comparison: both sides are public to anyone holding the
  // presentation, so there is no secret for timing to leak
  if (actual !== expected) throw ap2Rejected('checkout_binding_failed', context);
}
