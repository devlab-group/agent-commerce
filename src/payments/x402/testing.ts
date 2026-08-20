/**
 * Test/tooling surface, separate from the frozen `.` export.
 *
 * `docs/contracts.md` freezes exactly `createX402PaymentProvider` and
 * `createPaymentProof` on this package's main entry point. This module
 * exposes the local-chain tooling (Anvil bootstrap, deploy engine,
 * well-known dev accounts, and the `.deploy/local.json` manifest reader)
 * that `tests/e2e/payment`, this package's own `test/local-chain.test.ts`,
 * and other workspace packages (e.g. `demo/agent`) need — deliberately
 * kept off the main entry point so nothing depends on it through the
 * frozen provider surface.
 *
 * `readLocalChainManifest`/`LocalChainManifest`/`LOCAL_CHAIN_MANIFEST_PATH`
 * live in `./local-chain/manifest.ts`; `scripts/chain/manifest.ts`
 * re-exports the same module unchanged so `npm run chain:deploy` keeps a short
 * local import path. This is the one canonical implementation — see
 * `docs/contracts.md`, "Local chain deployment manifest".
 */

export { LOCAL_CHAIN_ID } from './chain.js';
export { ANVIL_WELL_KNOWN_ACCOUNTS, DEV_KEY_LABEL } from './local-chain/accounts.js';
export { type AnvilHandle, type StartAnvilOptions, startAnvil } from './local-chain/anvil.js';
export {
  type DeployLocalChainOptions,
  type DeployLocalChainResult,
  deployLocalChain,
  describeWellKnownAccounts,
} from './local-chain/deploy-engine.js';
export {
  LOCAL_CHAIN_MANIFEST_PATH,
  type LocalChainManifest,
  type LocalChainManifestKeyedAccount,
  type LocalChainManifestMerchant,
  readLocalChainManifest,
} from './local-chain/manifest.js';
