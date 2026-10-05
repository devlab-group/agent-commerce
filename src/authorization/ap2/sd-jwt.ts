/**
 * Parse the presentation, verify the issuer's signature, resolve disclosures,
 * and read the mandate from `delegate_payload`.
 *
 * `@sd-jwt/core` handles disclosures, including malformed, duplicate, and
 * unreferenced disclosures. `jose` verifies the signature. This module applies
 * the configured key, algorithm, audience, and time policy.
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
  /** The mandate element, with its nested disclosures resolved */
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
// Both spellings of the renamed Delegate SD-JWT hop types
const KEY_BOUND_TYPES: ReadonlySet<string> = new Set([
  'kb+sd-jwt',
  'kb-sd-jwt',
  'kb+sd-jwt+kb',
  'kb-sd-jwt+kb',
]);

export async function verifyMandate(
  presentation: string,
  deps: MandatePolicy,
  context: Ap2ErrorContext,
): Promise<VerifiedMandate> {
  // Direct mode does not verify `~~`-joined delegation chains.
  if (presentation.includes('~~')) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }

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

  // Reject a delegation hop presented without its mandate. Its type or
  // preceding-token hash identifies it.
  if (
    KEY_BOUND_TYPES.has(String(header['typ'])) ||
    rawPayload['sd_hash'] !== undefined ||
    rawPayload['issuer_jwt_hash'] !== undefined
  ) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }

  const { issuer, key } = await deps.trust.resolve(rawPayload['iss'], header['kid'], context);

  // AP2 permits an absent `aud`. If present, it must match the issuer's
  // configured audience. The checkout JWT has a separate audience check.
  const hasAudience = rawPayload['aud'] !== undefined;
  if (!hasAudience && deps.requireAudience === true) {
    throw ap2Rejected('invalid_claims', context);
  }

  const options: JWTVerifyOptions = {
    // Redundant with one resolved EC key, which already refuses `alg: none` and
    // a forged HMAC. It stops the header picking the algorithm if a key set is
    // ever resolved instead.
    algorithms: [AP2_SIGNING_ALGORITHM],
    // Also redundant, since the key was resolved *from* `iss`, and kept as a
    // backstop for a resolver that matches on something else
    ...(rawPayload['iss'] !== undefined ? { issuer: issuer.issuer } : {}),
    // Not redundant: `aud` is the presenter's claim, checked against the
    // configured value
    ...(hasAudience ? { audience: issuer.audience } : {}),
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

  const mandate = delegatedMandate(claims, context);
  // This verifier rejects KB-JWTs, so it cannot check a `cnf` holder-key
  // binding. Reject the mandate rather than ignore the binding.
  if (claims['cnf'] !== undefined || mandate['cnf'] !== undefined) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }
  requireClosedCheckoutMandate(mandate, context);
  // Closed mandates cannot carry constraints this verifier does not evaluate
  if (mandate['constraints'] !== undefined) {
    throw ap2Rejected('unsupported_mandate_type', context);
  }
  requireFreshness([verifiedPayload, mandate], deps, context);

  return { issuer: issuer.issuer, claims: mandate, signedToken: encodedJws };
}

/** What the verifier enforces beyond the signature */
export interface MandatePolicy {
  readonly trust: TrustStore;
  readonly clock: Clock;
  readonly clockSkewSeconds: number;
  /** Refuse a mandate with no `aud` */
  readonly requireAudience?: boolean;
  /** Refuse a mandate with no `exp`, at the top level or in the mandate content */
  readonly requireExpiry?: boolean;
}

/**
 * Read the single object in `delegate_payload` after disclosure resolution.
 * The reference SDK discloses this element. If none or multiple are present,
 * there is no single mandate to check.
 */
function delegatedMandate(
  claims: Record<string, unknown>,
  context: Ap2ErrorContext,
): Record<string, unknown> {
  const delegated = claims['delegate_payload'];
  // One shape only: claims at the top level are refused, not read a second way
  if (!Array.isArray(delegated)) throw ap2Rejected('unsupported_mandate_type', context);
  const disclosed = delegated.filter(isRecord);
  const [only] = disclosed;
  if (disclosed.length !== 1 || only === undefined) throw ap2Rejected('invalid_claims', context);
  return only;
}

/**
 * Matched on jose's stable error `code`, not its message. A client is owed
 * "expired" versus "did not verify"; anything finer describes our checks back
 * to whoever is probing them.
 */
function classifyJoseFailure(
  cause: unknown,
): 'expired' | 'wrong_audience' | 'invalid_claims' | 'invalid_signature' {
  const code = (cause as { code?: unknown })?.code;
  if (code === 'ERR_JWT_EXPIRED') return 'expired';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const { claim, reason } = cause as { claim?: unknown; reason?: unknown };
    if (claim === 'aud') return 'wrong_audience';
    // `invalid` is jose's reason for a time claim that is not a number
    if (claim === 'nbf' || claim === 'exp')
      return reason === 'invalid' ? 'invalid_claims' : 'expired';
  }
  return 'invalid_signature';
}

/**
 * Check `exp`, `nbf` and `iat` on the signed token and the disclosed mandate.
 * `jose` checks only the token's time claims. AP2 requires none of them;
 * policy can require `exp` in either location.
 */
function requireFreshness(
  sources: readonly Record<string, unknown>[],
  deps: MandatePolicy,
  context: Ap2ErrorContext,
): void {
  const nowSeconds = Math.floor(deps.clock.now().getTime() / 1000);
  let expires = false;
  for (const claims of sources) {
    const exp = claims['exp'];
    const iat = claims['iat'];
    if (exp !== undefined) {
      if (typeof exp !== 'number') throw ap2Rejected('invalid_claims', context);
      if (exp <= nowSeconds - deps.clockSkewSeconds) throw ap2Rejected('expired', context);
      expires = true;
    }
    const nbf = claims['nbf'];
    if (nbf !== undefined) {
      if (typeof nbf !== 'number') throw ap2Rejected('invalid_claims', context);
      if (nbf > nowSeconds + deps.clockSkewSeconds) throw ap2Rejected('expired', context);
    }
    if (iat !== undefined) {
      if (typeof iat !== 'number') throw ap2Rejected('invalid_claims', context);
      // A future `iat` is a broken signer, or a mandate minted to outlive its
      // own expiry window
      if (iat > nowSeconds + deps.clockSkewSeconds) throw ap2Rejected('expired', context);
    }
  }
  if (!expires && deps.requireExpiry === true) throw ap2Rejected('invalid_claims', context);
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
