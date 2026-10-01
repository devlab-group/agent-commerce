/**
 * src/authorization/ap2
 *
 * AP2 Direct Checkout Mandate verification. Everything reachable from here
 * pulls the optional peers (`jose`, `@sd-jwt/core`, `canonicalize`), so the
 * main entry and the CLI import the narrow modules instead of this barrel.
 */

export {
  type Ap2SigningKey,
  type CreateCheckoutJwtOptions,
  createCheckoutJwt,
} from './checkout-signer';
export {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_CHECKOUT_PROFILE,
  AP2_DEFAULT_CLOCK_SKEW_SECONDS,
  AP2_DIGEST_ALGORITHM,
  AP2_MAX_CLOCK_SKEW_SECONDS,
  AP2_MODES,
  AP2_SIGNING_ALGORITHM,
  AP2_SPEC_VERSION,
  type Ap2Mode,
} from './constants';
export {
  AP2_CAPABILITIES,
  AP2_UNSUPPORTED,
  buildAp2Descriptor,
} from './descriptor';
export { AP2_REJECTION_REASONS, type Ap2RejectionReason } from './errors';
export {
  type Ap2AuthorizationProvider,
  type Ap2AuthorizationProviderOptions,
  createAp2AuthorizationProvider,
} from './provider';
export {
  type Ap2AuthorizationState,
  type Ap2ReplayStore,
  createAp2ReplayStore,
} from './replay-store';
export type {
  Ap2AuthorizationConfig,
  Ap2TrustedIssuer,
  Ap2TrustedKey,
  EnabledAp2Config,
  VerifiedCheckoutMandate,
} from './types';
