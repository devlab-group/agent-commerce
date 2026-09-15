/**
 * Stage two: the merchant checkout JWT the mandate binds.
 *
 * Two things have to hold. The hash proves the buyer approved *this* document;
 * the signature proves the merchant issued it. Hash alone accepts a document
 * the buyer wrote themselves; signature alone accepts a genuine merchant
 * document this mandate never covered.
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
  // jose validates a time claim only when present, so requiring them is ours
  if (typeof exp !== 'number' || typeof iat !== 'number') {
    throw ap2Rejected('invalid_claims', context);
  }
  // `jti` is what replay defence and the receipt record, so it is required
  if (typeof jti !== 'string' || jti.length === 0) {
    throw ap2Rejected('invalid_claims', context);
  }
  const nowSeconds = Math.floor(deps.clock.now().getTime() / 1000);
  if (iat > nowSeconds + deps.clockSkewSeconds) throw ap2Rejected('expired', context);

  return { issuer: issuer.issuer, jwtId: jti, claims };
}

/**
 * Hashed as the bytes that arrived, never re-encoded from parsed claims: a
 * re-serialised payload has a different digest, and normalising first would
 * hash a document other than the one being verified
 */
async function requireMatchingHash(
  compact: string,
  expected: string,
  context: Ap2ErrorContext,
): Promise<void> {
  // sha-256 only: `_sd_alg` was already pinned to it upstream
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(compact));
  const actual = Buffer.from(digest).toString('base64url');
  // Plain comparison: both sides are public to anyone holding the
  // presentation, so there is no secret for timing to leak
  if (actual !== expected) throw ap2Rejected('checkout_binding_failed', context);
}
