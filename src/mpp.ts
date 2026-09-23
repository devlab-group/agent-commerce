/**
 * `@devlab.group/agent-commerce/mpp` - the MPP payment rail
 * (`charge` intent, `evm` method, EIP-3009 `authorization` credential).
 *
 * This metadata-only entry imports no optional peers. The `mppx` pin anchors
 * the planned provider and its profile tests; consumers do not need it to
 * read this surface.
 *
 * import { MPP_DESCRIPTOR } from '@devlab.group/agent-commerce/mpp';
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
