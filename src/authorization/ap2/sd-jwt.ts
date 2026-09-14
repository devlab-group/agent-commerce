/**
 * Stage one: parse the SD-JWT presentation, verify the issuer's signature and
 * resolve the disclosures into a claim set.
 *
 * The disclosure mechanics come from `@sd-jwt/core` rather than being written
 * out here. Three attacks live in that algorithm: a disclosure appended that
 * no digest in the payload references, the same disclosure presented twice,
 * and a disclosure that will not decode. The library refuses all three, and a
 * hand-rolled digest walk would be reimplementing exactly that, with less
 * coverage, on the path deciding whether a purchase was authorised.
 *
 * The cryptography is `jose`'s. This file supplies the policy around it: which
 * key, which algorithm, which audience, and what counts as a fresh mandate.
 */
import { decodeSdJwt, getClaims, splitSdJwt } from '@sd-jwt/core';
import { type JWTVerifyOptions, jwtVerify } from 'jose';
import type { Clock } from '../../core/index.js';
import {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_DIGEST_ALGORITHM,
  AP2_SIGNING_ALGORITHM,
} from './constants.js';
import { type Ap2ErrorContext, ap2Rejected } from './errors.js';
import type { TrustStore } from './trust.js';

export interface VerifiedMandate {
  readonly issuer: string;
  /** Every claim, with the presented disclosures resolved into place. */
  readonly claims: Readonly<Record<string, unknown>>;
}

/**
 * SHA-256 over a disclosure string.
 *
 * `@sd-jwt/core` passes the algorithm it read from `_sd_alg`, so this doubles
 * as the enforcement point: anything but sha-256 throws instead of being
 * quietly computed as sha-256, which would let a presentation declare one
 * algorithm and be checked under another.
 */
async function hasher(data: string | ArrayBuffer, algorithm: string): Promise<Uint8Array> {
  if (algorithm.toLowerCase() !== AP2_DIGEST_ALGORITHM) {
    throw new Error(`unsupported digest algorithm ${algorithm}`);
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parses and verifies the mandate half of a presentation.
 *
 * Order is the security boundary of this file: nothing is read out of the
 * payload as *trusted* until `jwtVerify` has returned. The header's `kid` and
 * the payload's `iss` are read before that, but only to choose which
 * configured key to try, and choosing wrong can only make the signature fail.
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
    // duplicate digest, and an `_sd_alg` this release does not implement.
    decoded = await decodeSdJwt(presentation, hasher);
    encodedJws = splitSdJwt(presentation).jwt;
  } catch (cause) {
    throw ap2Rejected('malformed_presentation', { ...context, cause });
  }

  // A key-binding JWT proves possession of the key a mandate was bound to.
  // Direct mode issues no bound mandates, so one arriving here belongs to a
  // flow this release does not verify, and ignoring it would mean silently
  // not checking a proof that was sent.
  if (decoded.kbJwt !== undefined) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }

  const rawPayload = asRecord(decoded.jwt.payload);
  const header = asRecord(decoded.jwt.header);
  if (rawPayload === undefined || header === undefined) {
    throw ap2Rejected('malformed_presentation', context);
  }

  const { issuer, key } = await deps.trust.resolve(rawPayload['iss'], header['kid'], context);

  const options: JWTVerifyOptions = {
    // Redundant today and kept anyway: the resolved key is an EC public key,
    // so jose already refuses `alg: none` and an HMAC forged against it. The
    // allowlist is what keeps that true if this ever resolves to a key set
    // rather than one key, where the header would get to pick.
    algorithms: [AP2_SIGNING_ALGORITHM],
    issuer: issuer.issuer,
    audience: issuer.audience,
    clockTolerance: deps.clockSkewSeconds,
    // The injected clock, not jose's own `Date.now()`, so an expiry test is a
    // test rather than a race against the wall clock.
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
    // Resolved against the VERIFIED payload. Handing `getClaims` the decoded
    // one would match disclosures against digests nobody signed.
    claims = (await getClaims(verifiedPayload, decoded.disclosures, hasher)) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    // Where an appended disclosure that no digest references is refused.
    throw ap2Rejected('malformed_presentation', { ...context, cause });
  }

  requireClosedCheckoutMandate(claims, context);

  return { issuer: issuer.issuer, claims };
}

/**
 * Maps a jose verification failure onto one of our coarse reasons.
 *
 * Matched on jose's stable error `code`, not its message. A client is owed
 * the difference between "your mandate has expired" and "it did not verify at
 * all"; anything finer describes our checks back to whoever is probing
 * them.
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
 * `exp` and `iat` are required, not merely checked when present.
 *
 * jose validates both only if the claim is there, so a mandate omitting `exp`
 * verifies and then never expires. An authorisation to spend money that is
 * valid forever is not something to accept because a field was absent.
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
  // An issuance timestamp in the future is either a broken signer or a mandate
  // minted to outlive the window its own `exp` describes.
  if (iat > nowSeconds + deps.clockSkewSeconds) throw ap2Rejected('expired', context);
}

/**
 * Exactly `mandate.checkout.1`, compared against the literal.
 *
 * A `startsWith` test would accept `mandate.checkout.1x`. Accepting the open
 * variant would be worse: it carries `allowed_merchants` and `line_items`
 * constraints this release does not evaluate, so a buyer would read their
 * spending limits as enforced when nothing had looked at them.
 */
function requireClosedCheckoutMandate(
  claims: Record<string, unknown>,
  context: Ap2ErrorContext,
): void {
  if (claims['vct'] !== AP2_CHECKOUT_MANDATE_VCT) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }
}
