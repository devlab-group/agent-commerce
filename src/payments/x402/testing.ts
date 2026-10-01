/**
 * Local-chain tooling for the repository's tests and demo: Anvil bootstrap,
 * the deploy engine, the well-known dev accounts and the `.deploy/local.json`
 * manifest reader.
 *
 * No package entry imports this module, so none of it is part of the published
 * library API.
 */

export { ANVIL_WELL_KNOWN_ACCOUNTS, DEV_KEY_LABEL } from './local-chain/accounts';
export { type AnvilHandle, type StartAnvilOptions, startAnvil } from './local-chain/anvil';
export {
  type DeployLocalChainOptions,
  type DeployLocalChainResult,
  deployLocalChain,
  describeWellKnownAccounts,
} from './local-chain/deploy-engine';
export {
  LOCAL_CHAIN_MANIFEST_PATH,
  type LocalChainManifest,
  type LocalChainManifestKeyedAccount,
  type LocalChainManifestMerchant,
  readLocalChainManifest,
} from './local-chain/manifest';
export { LOCAL_CHAIN_ID } from './networks';
