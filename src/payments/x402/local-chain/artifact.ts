/**
 * Loads the compiled MockUSDC artifact so the deploy script can use `viem`'s
 * `deployContract` directly, without shelling out to `forge script`.
 *
 * Resolution order (each step used only if the previous produced nothing):
 * 1. `contracts/out/MockUSDC.sol/MockUSDC.json` — fresh `forge build`
 * output, wins when present so local contract development always sees
 * current bytecode.
 * 2. `contracts/artifacts/MockUSDC.json` — the committed, slim (ABI +
 * bytecode only) artifact. This is the path Docker's `chain-deploy`
 * step actually uses: that image (`node:22-bookworm-slim`) has no
 * Foundry, and adding it there would bloat every service for one build
 * step. Regenerate it with `npx tsx scripts/chain/build-artifact.ts`
 * whenever `MockUSDC.sol` changes (a test asserts they haven't drifted
 * when `forge` is available — see `local-chain.test.ts`).
 * 3. Run `forge build` and retry (1) — only when neither exists AND
 * `forge` is on PATH.
 * 4. Otherwise throw a clear, actionable error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi } from 'viem';

const __dirname = dirname(fileURLToPath(import.meta.url));

// src/payments/x402/local-chain -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts');
const FORGE_OUT_PATH = join(CONTRACTS_DIR, 'out', 'MockUSDC.sol', 'MockUSDC.json');
export const COMMITTED_ARTIFACT_PATH = join(CONTRACTS_DIR, 'artifacts', 'MockUSDC.json');

interface FoundryArtifact {
  readonly abi: Abi;
  readonly bytecode: { readonly object: `0x${string}` };
}

export interface MockUsdcArtifact {
  readonly abi: Abi;
  readonly bytecode: `0x${string}`;
}

/** True when `forge` resolves on PATH — never throws. */
export function isForgeAvailable(): boolean {
  try {
    execFileSync('forge', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readForgeOutput(): MockUsdcArtifact | undefined {
  if (!existsSync(FORGE_OUT_PATH)) return undefined;
  const parsed = JSON.parse(readFileSync(FORGE_OUT_PATH, 'utf8')) as FoundryArtifact;
  if (!Array.isArray(parsed.abi) || typeof parsed.bytecode?.object !== 'string') {
    throw new Error(`MockUSDC artifact at ${FORGE_OUT_PATH} has an unexpected shape.`);
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

/** The committed slim artifact, or `undefined` if it hasn't been generated. */
export function readCommittedArtifactIfPresent(): MockUsdcArtifact | undefined {
  if (!existsSync(COMMITTED_ARTIFACT_PATH)) return undefined;
  const parsed = JSON.parse(readFileSync(COMMITTED_ARTIFACT_PATH, 'utf8')) as MockUsdcArtifact;
  if (!Array.isArray(parsed.abi) || typeof parsed.bytecode !== 'string') {
    throw new Error(
      `Committed MockUSDC artifact at ${COMMITTED_ARTIFACT_PATH} has an unexpected shape.`,
    );
  }
  return parsed;
}

/** Runs `forge build` and returns the resulting artifact. Requires Foundry; throws otherwise. */
export function buildFreshArtifactViaForge(): MockUsdcArtifact {
  execFileSync('forge', ['build'], { cwd: CONTRACTS_DIR, stdio: 'inherit' });
  const built = readForgeOutput();
  if (!built) {
    throw new Error(`forge build ran but ${FORGE_OUT_PATH} is still missing.`);
  }
  return built;
}

/** Regenerates the committed slim artifact from a fresh `forge build`. Used by `scripts/chain/build-artifact.ts`. */
export function regenerateCommittedArtifact(): MockUsdcArtifact {
  const built = buildFreshArtifactViaForge();
  mkdirSync(dirname(COMMITTED_ARTIFACT_PATH), { recursive: true });
  writeFileSync(COMMITTED_ARTIFACT_PATH, `${JSON.stringify(built, null, 2)}\n`, 'utf8');
  return built;
}

export function loadMockUsdcArtifact(): MockUsdcArtifact {
  const fresh = readForgeOutput();
  if (fresh) return fresh;

  const committed = readCommittedArtifactIfPresent();
  if (committed) return committed;

  if (isForgeAvailable()) {
    const built = buildFreshArtifactViaForge();
    if (built) return built;
  }

  throw new Error(
    `MockUSDC artifact not found: no fresh build at "${FORGE_OUT_PATH}", no committed copy at ` +
      `"${COMMITTED_ARTIFACT_PATH}", and "forge" is not on PATH to build one. ` +
      'On a host with Foundry, run "cd contracts && forge build", or regenerate the committed ' +
      'artifact with "npx tsx scripts/chain/build-artifact.ts".',
  );
}
