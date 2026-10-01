/**
 * Stage one: parse the presentation, verify the issuer's signature, resolve
 * the disclosures.
 *
 * Disclosure mechanics come from `@sd-jwt/core`, which refuses the three
 * attacks that live in that algorithm: an appended disclosure nothing
 * references, the same disclosure twice, and one that will not decode.
 * Cryptography is `jose`'s. This file supplies the policy: which key, which
 * algorithm, which audience, what counts as fresh.
 */
import { decodeSdJwt, getClaims, splitSdJwt } from '@sd-jwt/core';
import { type JWTVerifyOptions, jwtVerify } from 'jose';
import type { Clock } from '../../core';
import { isRecord } from '../../core/is-record';
import { AP2_CHECKOUT_MANDATE_VCT, AP2_DIGEST_ALGORITHM, AP2_SIGNING_ALGORITHM } from './constants';
import { type Ap2ErrorContext, ap2Rejected } from './errors';
import { sha256 } from './sha256';
import type { TrustStore } from './trust';

export interface VerifiedMandate {
  readonly issuer: string;
  /** Every claim, with the presented disclosures resolved into place */
  readonly claims: Readonly<Record<string, unknown>>;
  /**
   * The issuer-signed token on its own, without the disclosures.
   *
   * This, not the presentation string, is the stable identity of a mandate:
   * disclosing or withholding an optional claim rewrites the presentation and
   * leaves the signed token untouched. Replay defense keys on a digest of it.
   */
  readonly signedToken: string;
}

/**
 * `@sd-jwt/core` passes the algorithm it read from `_sd_alg`, so this is also
 * where a presentation declaring anything but sha-256 is refused
 */
function hasher(data: string | ArrayBuffer, algorithm: string): Uint8Array {
  if (algorithm.toLowerCase() !== AP2_DIGEST_ALGORITHM) {
    throw ap2Rejected('malformed_presentation');
  }
  return sha256(typeof data === 'string' ? data : new Uint8Array(data));
}

/**
 * Order is the security boundary here: nothing is trusted until `jwtVerify`
 * returns. `kid` and `iss` are read before that only to pick which configured
 * key to try, and picking wrong just makes the signature fail.
 */
export async function verifyMandate(
  presentation: string,
  deps: { readonly trust: TrustStore; readonly clock: Clock; readonly clockSkewSeconds: number },
  context: Ap2ErrorContext,
): Promise<VerifiedMandate> {
  let decoded: Awaited<ReturnType<typeof decodeSdJwt>>;
  let encodedJws: string;
  try {
    // Covers a malformed base JWT, a disclosure that will not decode, a
    // duplicate digest, and an `_sd_alg` other than sha-256
    decoded = await decodeSdJwt(presentation, hasher);
    encodedJws = splitSdJwt(presentation).jwt;
  } catch (cause) {
    throw ap2Rejected('malformed_presentation', { ...context, cause });
  }

  // Direct mode issues no key-bound mandates, so one arriving here belongs to
  // a flow we do not verify. Ignoring it would mean silently not checking a
  // proof that was sent.
  if (decoded.kbJwt !== undefined) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }

  const rawPayload = decoded.jwt.payload;
  const header = decoded.jwt.header;
  if (!isRecord(rawPayload) || !isRecord(header)) {
    throw ap2Rejected('malformed_presentation', context);
  }

  const { issuer, key } = await deps.trust.resolve(rawPayload['iss'], header['kid'], context);

  const options: JWTVerifyOptions = {
    // Redundant with one resolved EC key, which already refuses `alg: none` and
    // a forged HMAC. It stops the header picking the algorithm if a key set is
    // ever resolved instead.
    algorithms: [AP2_SIGNING_ALGORITHM],
    // Also redundant, since the key was resolved *from* `iss`, and kept as a
    // backstop for a resolver that matches on something else. `audience` is
    // not redundant: `aud` is the presenter's claim, checked against the
    // configured value.
    issuer: issuer.issuer,
    audience: issuer.audience,
    clockTolerance: deps.clockSkewSeconds,
    // Injected clock, not jose's `Date.now()`, so expiry is testable
    currentDate: deps.clock.now(),
  };

  let verifiedPayload: Record<string, unknown>;
  try {
    const result = await jwtVerify(encodedJws, key, options);
    verifiedPayload = result.payload as Record<string, unknown>;
  } catch (cause) {
    throw ap2Rejected(classifyJoseFailure(cause), { ...context, cause });
  }

  requireFreshness(verifiedPayload, deps, context);

  let claims: Record<string, unknown>;
  try {
    // Against the VERIFIED payload: the decoded one would match disclosures
    // against digests nobody signed
    claims = (await getClaims(verifiedPayload, decoded.disclosures, hasher)) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    // Where an appended disclosure that no digest references is refused
    throw ap2Rejected('malformed_presentation', { ...context, cause });
  }

  requireClosedCheckoutMandate(claims, context);

  return { issuer: issuer.issuer, claims, signedToken: encodedJws };
}

/**
 * Matched on jose's stable error `code`, not its message. A client is owed
 * "expired" versus "did not verify"; anything finer describes our checks back
 * to whoever is probing them.
 */
function classifyJoseFailure(cause: unknown): 'expired' | 'wrong_audience' | 'invalid_signature' {
  const code = (cause as { code?: unknown })?.code;
  if (code === 'ERR_JWT_EXPIRED') return 'expired';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const claim = (cause as { claim?: unknown }).claim;
    if (claim === 'aud') return 'wrong_audience';
    if (claim === 'nbf' || claim === 'exp') return 'expired';
  }
  return 'invalid_signature';
}

/**
 * Required, not merely checked when present: jose validates a time claim only
 * if it is there, so a mandate omitting `exp` would verify and never expire
 */
function requireFreshness(
  payload: Record<string, unknown>,
  deps: { readonly clock: Clock; readonly clockSkewSeconds: number },
  context: Ap2ErrorContext,
): void {
  const exp = payload['exp'];
  const iat = payload['iat'];
  if (typeof exp !== 'number' || typeof iat !== 'number') {
    throw ap2Rejected('invalid_claims', context);
  }
  const nowSeconds = Math.floor(deps.clock.now().getTime() / 1000);
  // A future `iat` is a broken signer, or a mandate minted to outlive its own
  // expiry window
  if (iat > nowSeconds + deps.clockSkewSeconds) throw ap2Rejected('expired', context);
}

// Exactly `mandate.checkout.1`; see AP2_CHECKOUT_MANDATE_VCT for why
function requireClosedCheckoutMandate(
  claims: Record<string, unknown>,
  context: Ap2ErrorContext,
): void {
  if (claims['vct'] !== AP2_CHECKOUT_MANDATE_VCT) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }
}
