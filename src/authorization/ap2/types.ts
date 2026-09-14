/**
 * AP2 trust configuration and the shape a successful verification produces.
 *
 * The trust types live here rather than in `src/config` so the dependency
 * points the same way `X402FacilitatorConfig` does: the subsystem owns the
 * shape of its own configuration and the config loader imports it. The
 * alternative is config owning a type the verifier has to re-describe, which
 * is how two definitions of one thing start.
 */
import type { AP2_SPEC_VERSION, Ap2Mode } from './constants.js';

export type { Ap2Mode };

/** One inline public verification key, trusted because an operator wrote it here. */
export interface Ap2TrustedKey {
  readonly kid: string;
  /** A public P-256 JWK. Validated member by member at config load. */
  readonly jwk: Readonly<Record<string, string>>;
}

/** One trusted issuer and the keys it signs with. */
export interface Ap2TrustedIssuer {
  readonly issuer: string;
  /**
   * The audience this issuer must address.
   *
   * Per issuer rather than one gateway-wide value: the Checkout Mandate is
   * addressed to the merchant while the checkout JWT it binds is addressed to
   * the gateway, so a single audience could not be right for both.
   */
  readonly audience: string;
  readonly keys: readonly Ap2TrustedKey[];
}

/**
 * Discriminated on `enabled`, like `AcpProtocolConfig`: an enabled AP2 config
 * carries everything the verifier needs, so nothing downstream asserts on an
 * optional field, and a half-configured trust policy is rejected at load.
 */
export type Ap2AuthorizationConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly specVersion: typeof AP2_SPEC_VERSION;
      readonly mode: Ap2Mode;
      readonly trust: {
        /** Signers of the Checkout Mandate itself. */
        readonly mandateIssuers: readonly Ap2TrustedIssuer[];
        /** Signers of the merchant checkout JWT the mandate binds. */
        readonly checkoutIssuers: readonly Ap2TrustedIssuer[];
      };
      readonly clockSkewSeconds: number;
      /** Its own SQLite file. An authorization replay is not a payment replay. */
      readonly replay: { readonly path: string };
    };

/** The enabled half, which is all the verifier ever runs against. */
export type EnabledAp2Config = Extract<Ap2AuthorizationConfig, { enabled: true }>;

/**
 * A Checkout Mandate that has passed every cryptographic check.
 *
 * Cryptographically valid is not the same as authorising *this* purchase.
 * Binding the mandate to the resolved resource, input and price is a separate
 * step, and nothing here should be read as having done it.
 */
export interface VerifiedCheckoutMandate {
  /** Issuer of the Checkout Mandate, as verified against its signature. */
  readonly mandateIssuer: string;
  /** Issuer of the merchant checkout JWT the mandate binds. */
  readonly checkoutIssuer: string;
  /** `jti` of the checkout JWT. Safe to record: it is an opaque identifier. */
  readonly checkoutJwtId: string;
  /**
   * Claims of the merchant checkout JWT, signature verified.
   *
   * This is where the Agent Commerce checkout profile lives, and what the
   * purchase binding reads.
   */
  readonly checkoutClaims: Readonly<Record<string, unknown>>;
  /** Mandate claims with every presented disclosure resolved into place. */
  readonly mandateClaims: Readonly<Record<string, unknown>>;
}
