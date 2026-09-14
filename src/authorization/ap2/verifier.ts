/**
 * The Direct Checkout Mandate verifier.
 *
 * Runs the two stages in the one order they work in: the mandate's own
 * signature first, then the merchant checkout JWT it binds. A failure at
 * either stage is a refusal, and there is no partial result, because "the
 * mandate verified but the checkout document did not" authorises nothing.
 *
 * What this proves is narrow, and worth stating so nobody reads more into it:
 * a trusted issuer signed this mandate, it has not expired, it is addressed to
 * us, and it binds a checkout document the merchant really signed. It does NOT
 * prove the mandate authorises the purchase in front of us. That comparison
 * runs the checkout profile against the resolved resource, input and price,
 * and it is a separate step. A caller treating this result as permission to
 * settle has skipped it.
 */
import type { Clock } from '../../core/index.js';
import { verifyCheckoutJwt } from './checkout-jwt.js';
import { type Ap2ErrorContext, ap2Rejected } from './errors.js';
import { verifyMandate } from './sd-jwt.js';
import { createTrustStore } from './trust.js';
import type { EnabledAp2Config, VerifiedCheckoutMandate } from './types.js';

export interface Ap2VerifierOptions {
  readonly config: EnabledAp2Config;
  readonly clock: Clock;
}

export interface Ap2MandateVerifier {
  verify(presentation: string, context?: Ap2ErrorContext): Promise<VerifiedCheckoutMandate>;
  /** Trusted issuer ids, for `doctor`. Counts and names only, never keys. */
  trustedIssuers(): { readonly mandate: readonly string[]; readonly checkout: readonly string[] };
}

export function createAp2MandateVerifier(options: Ap2VerifierOptions): Ap2MandateVerifier {
  // Two stores, not one shared list. A party trusted to sign checkout
  // documents is not thereby trusted to issue mandates, and merging the lists
  // would silently grant each the other's authority.
  const mandateTrust = createTrustStore(options.config.trust.mandateIssuers);
  const checkoutTrust = createTrustStore(options.config.trust.checkoutIssuers);
  const deps = { clock: options.clock, clockSkewSeconds: options.config.clockSkewSeconds };

  return {
    async verify(
      presentation: string,
      context: Ap2ErrorContext = {},
    ): Promise<VerifiedCheckoutMandate> {
      if (typeof presentation !== 'string' || presentation.length === 0) {
        throw ap2Rejected('malformed_presentation', context);
      }

      const mandate = await verifyMandate(presentation, { ...deps, trust: mandateTrust }, context);
      const checkout = await verifyCheckoutJwt(
        mandate.claims,
        { ...deps, trust: checkoutTrust },
        context,
      );

      return {
        mandateIssuer: mandate.issuer,
        checkoutIssuer: checkout.issuer,
        checkoutJwtId: checkout.jwtId,
        checkoutClaims: checkout.claims,
        mandateClaims: mandate.claims,
      };
    },

    trustedIssuers() {
      return { mandate: mandateTrust.issuerIds(), checkout: checkoutTrust.issuerIds() };
    },
  };
}
