/**
 * The Direct Checkout Mandate verifier: mandate signature first, then the
 * merchant checkout JWT it binds. Either stage failing is a refusal.
 *
 * Verification establishes that a trusted issuer signed the mandate, its
 * supplied time and audience claims pass policy, and it binds a checkout JWT
 * signed by a trusted merchant issuer. `bindMandateToPurchase` separately
 * checks the purchase before settlement.
 */
import type { Clock } from '../../core';
import { verifyCheckoutJwt } from './checkout-jwt';
import { type Ap2ErrorContext, ap2Rejected } from './errors';
import { verifyMandate } from './sd-jwt';
import { sha256 } from './sha256';
import { createTrustStore } from './trust';
import type { EnabledAp2Config, VerifiedCheckoutMandate } from './types';

export interface Ap2VerifierOptions {
  readonly config: EnabledAp2Config;
  readonly clock: Clock;
}

export interface Ap2MandateVerifier {
  verify(presentation: string, context?: Ap2ErrorContext): Promise<VerifiedCheckoutMandate>;
  /** Trusted issuer ids, for the provider's health detail. Never keys */
  trustedIssuers(): { readonly mandate: readonly string[]; readonly checkout: readonly string[] };
}

/**
 * Algorithm-prefixed so a future digest change is visible in stored references
 * rather than silently producing unequal values for one mandate
 */
function mandateReference(signedToken: string): string {
  return `sha256:${sha256(signedToken).toString('base64url')}`;
}

export function createAp2MandateVerifier(options: Ap2VerifierOptions): Ap2MandateVerifier {
  // Two stores, not one list: signing the merchant's checkout documents must
  // not confer the power to issue mandates
  const mandateTrust = createTrustStore(options.config.trust.mandateIssuers);
  const checkoutTrust = createTrustStore(options.config.trust.checkoutIssuers);
  const deps = { clock: options.clock, clockSkewSeconds: options.config.clockSkewSeconds };
  const mandatePolicy = {
    ...deps,
    trust: mandateTrust,
    requireAudience: options.config.requireMandateAudience === true,
    requireExpiry: options.config.requireMandateExpiry === true,
  };

  return {
    async verify(
      presentation: string,
      context: Ap2ErrorContext = {},
    ): Promise<VerifiedCheckoutMandate> {
      if (typeof presentation !== 'string' || presentation.length === 0) {
        throw ap2Rejected('malformed_presentation', context);
      }

      const mandate = await verifyMandate(presentation, mandatePolicy, context);
      const checkout = await verifyCheckoutJwt(
        mandate.claims,
        { ...deps, trust: checkoutTrust },
        context,
      );

      return {
        reference: mandateReference(mandate.signedToken),
        mandateIssuer: mandate.issuer,
        checkoutIssuer: checkout.issuer,
        checkoutJwtId: checkout.jwtId,
        checkoutClaims: checkout.claims,
      };
    },

    trustedIssuers() {
      return { mandate: mandateTrust.issuerIds(), checkout: checkoutTrust.issuerIds() };
    },
  };
}
