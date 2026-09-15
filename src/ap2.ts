/**
 * `@devlab.group/agent-commerce/ap2` - AP2 Direct Checkout Mandate verification.
 *
 * A separate entry point because mandate verification brings a JOSE stack and
 * an SD-JWT parser, and a gateway serving no authorization-gated resource
 * should not install either.
 *
 * npm install @devlab.group/agent-commerce jose @sd-jwt/core canonicalize
 * import { ap2 } from '@devlab.group/agent-commerce/ap2';
 *
 * Authorization is not a transport and not a payment rail. It gates settlement
 * on a resource that also takes a real payment proof, and never unlocks one on
 * its own.
 */

export {
  AP2_CAPABILITIES,
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_CHECKOUT_PROFILE,
  AP2_DEFAULT_CLOCK_SKEW_SECONDS,
  AP2_MAX_CLOCK_SKEW_SECONDS,
  AP2_REJECTION_REASONS,
  AP2_SIGNING_ALGORITHM,
  AP2_SPEC_VERSION,
  AP2_UNSUPPORTED,
  type Ap2AuthorizationConfig,
  type Ap2AuthorizationProvider,
  type Ap2AuthorizationProviderOptions,
  type Ap2Mode,
  type Ap2RejectionReason,
  type Ap2TrustedIssuer,
  type Ap2TrustedKey,
  createAp2AuthorizationProvider,
  // `ap2` reads well at a call site; the full name reads better in a trace.
  createAp2AuthorizationProvider as ap2,
  type EnabledAp2Config,
} from './authorization/ap2/index.js';
