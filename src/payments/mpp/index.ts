// The rail's metadata, with no peer imports, so the main entry and the CLI
// can load it without `mppx`. src/mpp.ts adds the provider.

export {
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPP_SPEC_REPOSITORY,
  MPP_SUPPORTED_SPEC,
  MPPX_VERSION,
} from './constants';
export { MPP_DESCRIPTOR } from './descriptor';
