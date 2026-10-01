/**
 * `@devlab.group/agent-commerce/mpp`: the MPP payment rail (`charge` intent,
 * `evm` method, EIP-3009 `authorization` credential).
 *
 *   npm install @devlab.group/agent-commerce mppx viem @x402/core @x402/evm
 *   import { mpp } from '@devlab.group/agent-commerce/mpp';
 *
 * MPP checks the credential locally, then verifies and settles through the x402
 * facilitator named in its options. That install covers the local facilitator
 * and remote facilitators with `none` or `bearer` auth; `auth.type: cdp` also
 * needs `@coinbase/x402`.
 */

export {
  MPP_DESCRIPTOR,
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPP_SPEC_REPOSITORY,
  MPP_SUPPORTED_SPEC,
  MPPX_VERSION,
} from './payments/mpp';
export {
  createMppPaymentProvider,
  // `mpp` reads well at a call site; the full name reads better in a stack trace
  createMppPaymentProvider as mpp,
  type MppProviderOptions,
} from './payments/mpp/provider';
