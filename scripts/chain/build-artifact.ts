/**
 * Regenerates `contracts/artifacts/MockUSDC.json`, the committed ABI + bytecode
 * that `loadMockUsdcArtifact()` falls back to without a fresh forge build, as
 * in Docker's `chain-deploy` step. Requires Foundry.
 *
 * Run whenever `contracts/src/MockUSDC.sol` changes:
 *   npx tsx scripts/chain/build-artifact.ts
 */
import { regenerateCommittedArtifact } from '../../src/payments/x402/local-chain/artifact';

const artifact = regenerateCommittedArtifact();
console.log(
  `Wrote contracts/artifacts/MockUSDC.json (${artifact.abi.length} ABI entries, bytecode ${artifact.bytecode.length} chars).`,
);
