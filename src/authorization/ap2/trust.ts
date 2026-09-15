/**
 * Static key resolution.
 *
 * Every key was written into `config.yaml` by an operator. No JWKS fetch, no
 * `jku`, no `x5u`. A mandate's `iss` and `kid` only choose *which* trusted key
 * verifies it; an unrecognised pair is refused, so a mandate can never
 * nominate its own signer.
 *
 * Not a "try every key" loop: that would make `kid` advisory and accept a
 * mandate that named a key it was not signed with.
 */
import { importJWK, type JWK } from 'jose';
import { AP2_SIGNING_ALGORITHM } from './constants.js';
import { type Ap2ErrorContext, ap2Rejected, ap2Unavailable } from './errors.js';
import type { Ap2TrustedIssuer } from './types.js';

/** Named off `importJWK` because `CryptoKey` is a DOM type we do not load */
export type VerificationKey = Awaited<ReturnType<typeof importJWK>>;

export interface ResolvedKey {
  readonly issuer: Ap2TrustedIssuer;
  readonly key: VerificationKey;
}

/**
 * Resolves `(iss, kid)` against one configured issuer list. Caches the import
 * promise, not the key, so concurrent requests for a cold key share one import.
 */
export function createTrustStore(issuers: readonly Ap2TrustedIssuer[]) {
  const byIssuer = new Map(issuers.map((entry) => [entry.issuer, entry]));
  const imported = new Map<string, Promise<VerificationKey>>();

  return {
    /** Every trusted issuer id, for diagnostics. Never the keys themselves */
    issuerIds(): readonly string[] {
      return [...byIssuer.keys()];
    },

    async resolve(iss: unknown, kid: unknown, context: Ap2ErrorContext): Promise<ResolvedKey> {
      if (typeof iss !== 'string' || iss.length === 0) {
        throw ap2Rejected('invalid_claims', context);
      }
      const issuer = byIssuer.get(iss);
      if (issuer === undefined) throw ap2Rejected('untrusted_issuer', context);

      // Not defaulted to the issuer's only key: mid-rotation there are two,
      // and the gateway should not guess which one signed this
      if (typeof kid !== 'string' || kid.length === 0) {
        throw ap2Rejected('unknown_key', context);
      }
      const trusted = issuer.keys.find((candidate) => candidate.kid === kid);
      if (trusted === undefined) throw ap2Rejected('unknown_key', context);

      // JSON, not a joined string: both halves are operator-chosen and could
      // contain whatever separator we picked
      const cacheKey = JSON.stringify([iss, kid]);
      let pending = imported.get(cacheKey);
      if (pending === undefined) {
        pending = importJWK(trusted.jwk as JWK, AP2_SIGNING_ALGORITHM);
        imported.set(cacheKey, pending);
      }

      try {
        return { issuer, key: await pending };
      } catch (cause) {
        // Config already checked this JWK member by member, so reaching here
        // means our config is broken, not the mandate. Drop the cached
        // rejection so a fixed config is not still failing against it.
        imported.delete(cacheKey);
        throw ap2Unavailable('configured verification key could not be imported', {
          ...context,
          cause,
        });
      }
    },
  };
}

export type TrustStore = ReturnType<typeof createTrustStore>;
