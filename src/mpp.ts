/**
 * `@devlab.group/agent-commerce/mpp` - the MPP payment rail
 * (`charge` intent, `evm` method, EIP-3009 `authorization` credential).
 *
 *   npm install @devlab.group/agent-commerce mppx viem @x402/core @x402/evm
 *   import { mpp } from '@devlab.group/agent-commerce/mpp';
 *   import { x402 } from '@devlab.group/agent-commerce/x402';
 *
 * MPP verifies locally, then delegates settlement to the x402 provider passed
 * as `settlement`. The install command covers local, unauthenticated and bearer
 * facilitator modes; `auth.type: cdp` also requires `@coinbase/x402`.
 */

export {
  MPP_DESCRIPTOR,
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPP_SPEC_REPOSITORY,
  MPP_SUPPORTED_SPEC,
  MPPX_VERSION,
} from './payments/mpp/index.js';
export {
  createMppPaymentProvider,
  // `mpp` reads well at a call site; the full name reads better in a trace
  createMppPaymentProvider as mpp,
  type MppProviderOptions,
} from './payments/mpp/provider.js';
