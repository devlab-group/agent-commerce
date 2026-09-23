/**
 * `@devlab.group/agent-commerce/mpp` - the MPP payment rail
 * (`charge` intent, `evm` method, EIP-3009 `authorization` credential).
 *
 *   npm install @devlab.group/agent-commerce mppx viem
 *   import { mpp } from '@devlab.group/agent-commerce/mpp';
 *
 * The provider issues challenges and verifies credentials. It does not
 * settle, so its descriptor reports `planned`.
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
