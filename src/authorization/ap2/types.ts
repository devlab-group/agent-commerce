/**
 * AP2 trust configuration and the shape a successful verification produces.
 *
 * The subsystem owns its config shape and the config loader imports it, as
 * with `X402FacilitatorConfig`.
 */
import type { AP2_SPEC_VERSION, Ap2Mode } from './constants';

export type { Ap2Mode };

/** One inline public verification key, trusted because an operator wrote it here */
export interface Ap2TrustedKey {
  readonly kid: string;
  /** A public P-256 JWK. Validated member by member at config load */
  readonly jwk: Readonly<Record<string, string>>;
}

/** One trusted issuer and the keys it signs with */
export interface Ap2TrustedIssuer {
  readonly issuer: string;
  /**
   * Per issuer, not gateway-wide: a mandate is addressed to the merchant, while
   * the checkout JWT it binds is addressed to the gateway
   */
  readonly audience: string;
  readonly keys: readonly Ap2TrustedKey[];
}

/**
 * Discriminated on `enabled`, like `AcpProtocolConfig`: an enabled config
 * carries everything the verifier needs, so nothing downstream asserts on an
 * optional field
 */
export type Ap2AuthorizationConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly specVersion: typeof AP2_SPEC_VERSION;
      readonly mode: Ap2Mode;
      readonly trust: {
        /** Signers of the Checkout Mandate itself */
        readonly mandateIssuers: readonly Ap2TrustedIssuer[];
        /** Signers of the merchant checkout JWT the mandate binds */
        readonly checkoutIssuers: readonly Ap2TrustedIssuer[];
      };
      readonly clockSkewSeconds: number;
      /** Its own SQLite file. An authorization replay is not a payment replay */
      readonly replay: { readonly path: string };
    };

/** The enabled half, which is all the verifier ever runs against */
export type EnabledAp2Config = Extract<Ap2AuthorizationConfig, { enabled: true }>;

/**
 * A Checkout Mandate that passed every cryptographic check.
 *
 * Valid is not the same as authorizing *this* purchase. Binding it to the
 * resolved resource, input and price is a separate step
 * (`bindMandateToPurchase`).
 */
export interface VerifiedCheckoutMandate {
  /**
   * `sha256:<base64url>` over the issuer-signed token. Stable across every
   * presentation of one mandate, which is what makes it a usable replay key,
   * and safe to record in a receipt.
   */
  readonly reference: string;
  /** Issuer of the Checkout Mandate, as verified against its signature */
  readonly mandateIssuer: string;
  /** Issuer of the merchant checkout JWT the mandate binds */
  readonly checkoutIssuer: string;
  /** `jti` of the checkout JWT. Safe to record: it is an opaque identifier */
  readonly checkoutJwtId: string;
  /** Signature-verified checkout JWT claims. Carries the checkout profile */
  readonly checkoutClaims: Readonly<Record<string, unknown>>;
}
