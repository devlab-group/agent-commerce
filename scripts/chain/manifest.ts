/**
 * CLI-facing re-export.
 *
 * The implementation lives in `src/payments/x402/local-chain/manifest.ts`
 * so any workspace package can import it via
 * `src/payments/x402/testing.ts` (see `docs/contracts.md`) —
 * `scripts/chain` itself sits outside `src/` and has no
 * `node_modules` of its own, so it could never be the canonical home for a
 * type other workspace packages need to import. This file exists only so
 * `scripts/chain/deploy.ts` (and `npm run chain:deploy`) keep a short, local
 * import path.
 */
export {
  LOCAL_CHAIN_MANIFEST_PATH,
  type LocalChainManifest,
  type LocalChainManifestKeyedAccount,
  type LocalChainManifestMerchant,
  readLocalChainManifest,
} from '../../src/payments/x402/local-chain/manifest.js';
