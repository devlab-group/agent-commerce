/**
 * Deploys MockUSDC to the local deterministic chain, mints the demo buyer's
 * starting balance, ensures the demo accounts have gas, and writes
 * `.deploy/local.json` — the manifest every other package reads instead of
 * hard-coding an address (see docs/contracts.md).
 *
 * Idempotent: if a manifest already exists and its asset address still has
 * code on the currently-running chain (i.e. anvil was not restarted since
 * the last deploy), the existing deployment is reused — the buyer balance is
 * topped up to the target if needed, nothing is redeployed or double-minted.
 *
 * The heavy lifting (viem calls) lives in
 * `src/payments/x402/local-chain/deploy-engine.ts`; this file is a
 * thin CLI wrapper because `scripts/chain` has no `node_modules` of its own
 * (see the comment in that module for why).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEV_KEY_LABEL } from '../../src/payments/x402/local-chain/accounts.js';
import {
  assertNoUnknownDeployment,
  deployLocalChain,
  describeWellKnownAccounts,
} from '../../src/payments/x402/local-chain/deploy-engine.js';
import { LOCAL_CHAIN_MANIFEST_PATH, type LocalChainManifest } from './manifest.js';

const DEFAULT_BUYER_INITIAL_BALANCE = '100.00';

async function main(): Promise<void> {
  const rpcUrl = process.env['X402_RPC_URL'] ?? 'http://127.0.0.1:8545';
  const manifestPath =
    process.env['LOCAL_CHAIN_MANIFEST'] ?? join(process.cwd(), LOCAL_CHAIN_MANIFEST_PATH);
  const buyerInitialBalance =
    process.env['X402_BUYER_INITIAL_BALANCE'] ?? DEFAULT_BUYER_INITIAL_BALANCE;

  const existingAsset = readExistingAssetAddress(manifestPath);

  // Refuse an ambiguous silent double-deploy: if this run has no known
  // deployment (e.g. its own manifest is missing/stale) but the facilitator
  // key has already transacted on this chain, someone else likely deployed
  // here already (e.g. `docker compose up`'s chain-deploy service) — see
  // assertNoUnknownDeployment's doc comment in deploy-engine.ts.
  await assertNoUnknownDeployment(rpcUrl, existingAsset);

  console.log(`Deploying to ${rpcUrl}...`);
  console.log('Well-known local dev accounts (from the standard Anvil test mnemonic):');
  console.log(describeWellKnownAccounts());

  const result = await deployLocalChain(
    { rpcUrl, buyerInitialBalance, log: (msg) => console.log(msg) },
    existingAsset,
  );

  const manifest: LocalChainManifest = {
    chainId: result.chainId,
    rpcUrl: result.rpcUrl,
    // Distinct from rpcUrl only inside Docker, where rpcUrl is the
    // container-internal address (e.g. "http://anvil:8545") and HOST_RPC_URL
    // is set to the host-reachable published port. A bare host deploy has no
    // HOST_RPC_URL set, so this legitimately equals rpcUrl — they really are
    // the same endpoint there.
    hostRpcUrl: process.env['HOST_RPC_URL'] ?? result.rpcUrl,
    asset: result.asset,
    assetName: result.assetName,
    assetVersion: result.assetVersion,
    assetDecimals: result.assetDecimals,
    merchant: {
      address: result.merchant.address,
      privateKeyLabel: DEV_KEY_LABEL,
    },
    buyer: {
      address: result.buyer.address,
      privateKey: result.buyer.privateKey,
      note: DEV_KEY_LABEL,
    },
    facilitator: {
      address: result.facilitator.address,
      privateKey: result.facilitator.privateKey,
      note: DEV_KEY_LABEL,
    },
    buyerInitialBalance: result.buyerInitialBalance,
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`\nWrote manifest to ${manifestPath}`);
  console.log(`  asset (MockUSDC): ${manifest.asset}`);
  console.log(`  merchant payTo:   ${manifest.merchant.address}  (${DEV_KEY_LABEL})`);
  console.log(`  buyer:            ${manifest.buyer.address}  (${DEV_KEY_LABEL})`);
  console.log(`  buyer balance:    ${manifest.buyerInitialBalance} ${manifest.assetName}`);
  console.log(
    result.freshlyDeployed
      ? '  status:           freshly deployed'
      : '  status:           reused existing deployment',
  );
}

function readExistingAssetAddress(manifestPath: string): `0x${string}` | undefined {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { asset?: unknown };
    return typeof parsed.asset === 'string' ? (parsed.asset as `0x${string}`) : undefined;
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
