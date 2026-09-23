// Metadata only, with no peer imports, so the main entry and the CLI can read
// it without `mppx`. The provider is exported from src/mpp.ts.

export {
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPP_SPEC_REPOSITORY,
  MPP_SUPPORTED_SPEC,
  MPPX_VERSION,
} from './constants.js';
export { MPP_DESCRIPTOR } from './descriptor.js';
