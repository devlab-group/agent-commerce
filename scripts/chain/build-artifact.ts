/**
 * Regenerates `contracts/artifacts/MockUSDC.json` — the committed, slim
 * (ABI + bytecode only) artifact `loadMockUsdcArtifact()` falls back to when
 * `forge` isn't on PATH (e.g. the Docker `chain-deploy` step, which runs in
 * `node:22-bookworm-slim` with no Foundry). Requires Foundry on this host.
 *
 * Run whenever `contracts/src/MockUSDC.sol` changes:
 * npx tsx scripts/chain/build-artifact.ts
 */
import { regenerateCommittedArtifact } from '../../src/payments/x402/local-chain/artifact.js';

const artifact = regenerateCommittedArtifact();
console.log(
  `Wrote contracts/artifacts/MockUSDC.json (${artifact.abi.length} ABI entries, bytecode ${artifact.bytecode.length} chars).`,
);
