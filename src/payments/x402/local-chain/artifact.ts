/**
 * Loads the compiled MockUSDC artifact so the deploy engine can deploy it with
 * viem, without `forge script`.
 *
 * Resolution order, each step only if the previous found nothing:
 * 1. `contracts/out/MockUSDC.sol/MockUSDC.json`, a fresh `forge build`, so
 *    contract development always sees current bytecode.
 * 2. `contracts/artifacts/MockUSDC.json`, the committed ABI + bytecode. Docker's
 *    `chain-deploy` step uses it, because its `node:22-bookworm-slim` image has
 *    no Foundry. Regenerate it with `npx tsx scripts/chain/build-artifact.ts`
 *    whenever `MockUSDC.sol` changes; `local-chain.test.ts` fails on drift
 *    when `forge` is available.
 * 3. `forge build`, when `forge` is on PATH.
 * 4. Otherwise, an actionable error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi } from 'viem';
import { CommerceError } from '../../../core';

const __dirname = dirname(fileURLToPath(import.meta.url));

// src/payments/x402/local-chain -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts');
const FORGE_OUT_PATH = join(CONTRACTS_DIR, 'out', 'MockUSDC.sol', 'MockUSDC.json');
const COMMITTED_ARTIFACT_PATH = join(CONTRACTS_DIR, 'artifacts', 'MockUSDC.json');

interface FoundryArtifact {
  readonly abi: Abi;
  readonly bytecode: { readonly object: `0x${string}` };
}

export interface MockUsdcArtifact {
  readonly abi: Abi;
  readonly bytecode: `0x${string}`;
}

/** True when `forge` resolves on PATH. Never throws */
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
    throw new CommerceError(
      'INTERNAL_ERROR',
      `MockUSDC artifact at ${FORGE_OUT_PATH} has an unexpected shape.`,
    );
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

/** The committed slim artifact, or `undefined` if it hasn't been generated */
export function readCommittedArtifactIfPresent(): MockUsdcArtifact | undefined {
  if (!existsSync(COMMITTED_ARTIFACT_PATH)) return undefined;
  const parsed = JSON.parse(readFileSync(COMMITTED_ARTIFACT_PATH, 'utf8')) as MockUsdcArtifact;
  if (!Array.isArray(parsed.abi) || typeof parsed.bytecode !== 'string') {
    throw new CommerceError(
      'INTERNAL_ERROR',
      `Committed MockUSDC artifact at ${COMMITTED_ARTIFACT_PATH} has an unexpected shape.`,
    );
  }
  return parsed;
}

/** Runs `forge build` and returns the resulting artifact. Throws without Foundry */
export function buildFreshArtifactViaForge(): MockUsdcArtifact {
  execFileSync('forge', ['build'], { cwd: CONTRACTS_DIR, stdio: 'inherit' });
  const built = readForgeOutput();
  if (!built) {
    throw new CommerceError(
      'INTERNAL_ERROR',
      `forge build ran but ${FORGE_OUT_PATH} is still missing.`,
    );
  }
  return built;
}

/** Regenerates the committed slim artifact from a fresh `forge build` */
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

  if (isForgeAvailable()) return buildFreshArtifactViaForge();

  throw new CommerceError(
    'CONFIG_INVALID',
    `MockUSDC artifact not found: no fresh build at "${FORGE_OUT_PATH}", no committed copy at ` +
      `"${COMMITTED_ARTIFACT_PATH}", and "forge" is not on PATH to build one. ` +
      'On a host with Foundry, run "cd contracts && forge build", or regenerate the committed ' +
      'artifact with "npx tsx scripts/chain/build-artifact.ts".',
  );
}
