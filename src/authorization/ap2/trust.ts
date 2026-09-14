/**
 * Static key resolution.
 *
 * Every key this verifier will ever use was written into `config.yaml` by an
 * operator. There is no JWKS fetch, no `jku`, no `x5u`, no discovery from an
 * issuer-controlled URL. A mandate chooses *which* trusted key verifies it,
 * through `iss` and `kid`, and nothing more: an unrecognised pair is refused
 * rather than resolved. That is what keeps a mandate from nominating its own
 * signer, and it is why the config loader refuses a JWK member naming a URL.
 *
 * The lookup is deliberately not a "try every key" loop. Trying keys until
 * one verifies would make `kid` advisory and would quietly accept a mandate
 * that named a key it was not signed with.
 */
import { importJWK, type JWK } from 'jose';
import { AP2_SIGNING_ALGORITHM } from './constants.js';
import { type Ap2ErrorContext, ap2Rejected, ap2Unavailable } from './errors.js';
import type { Ap2TrustedIssuer } from './types.js';

/**
 * Whatever `importJWK` hands back on this runtime, named off the function
 * itself rather than spelled out. `CryptoKey` is a DOM type and server code
 * here does not load the DOM lib on purpose.
 */
export type VerificationKey = Awaited<ReturnType<typeof importJWK>>;

export interface ResolvedKey {
  readonly issuer: Ap2TrustedIssuer;
  readonly key: VerificationKey;
}

/**
 * Resolves `(iss, kid)` against one configured issuer list.
 *
 * Imported keys are cached because `importJWK` does real work and the same
 * handful of keys verifies every mandate. The cache holds the promise rather
 * than the resolved key, so two concurrent requests for a cold key do one
 * import between them.
 */
export function createTrustStore(issuers: readonly Ap2TrustedIssuer[]) {
  const byIssuer = new Map(issuers.map((entry) => [entry.issuer, entry]));
  const imported = new Map<string, Promise<VerificationKey>>();

  return {
    /** Every trusted issuer id, for diagnostics. Never the keys themselves. */
    issuerIds(): readonly string[] {
      return [...byIssuer.keys()];
    },

    async resolve(iss: unknown, kid: unknown, context: Ap2ErrorContext): Promise<ResolvedKey> {
      if (typeof iss !== 'string' || iss.length === 0) {
        throw ap2Rejected('invalid_claims', context);
      }
      const issuer = byIssuer.get(iss);
      if (issuer === undefined) throw ap2Rejected('untrusted_issuer', context);

      // A missing kid is refused rather than defaulted to the issuer's only
      // key. An issuer mid-rotation has two, and a presentation that declines
      // to say which one it used should not have the gateway guess.
      if (typeof kid !== 'string' || kid.length === 0) {
        throw ap2Rejected('unknown_key', context);
      }
      const trusted = issuer.keys.find((candidate) => candidate.kid === kid);
      if (trusted === undefined) throw ap2Rejected('unknown_key', context);

      // JSON rather than a joined string: an issuer id and a kid are both
      // operator-chosen, and any separator picked out of the air is one they
      // could contain.
      const cacheKey = JSON.stringify([iss, kid]);
      let pending = imported.get(cacheKey);
      if (pending === undefined) {
        pending = importJWK(trusted.jwk as JWK, AP2_SIGNING_ALGORITHM);
        imported.set(cacheKey, pending);
      }

      try {
        return { issuer, key: await pending };
      } catch (cause) {
        // The config loader already checked this JWK member by member, so
        // reaching here means our own configuration is broken rather than the
        // buyer's mandate. Drop the cached rejection so a fixed config is not
        // still failing against a poisoned cache entry.
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
