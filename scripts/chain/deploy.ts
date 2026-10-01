/**
 * `npm run chain:deploy`: deploys MockUSDC to the local chain, gives the demo
 * accounts gas, mints the buyer's starting balance and writes
 * `.deploy/local.json`. The chain work lives in
 * `src/payments/x402/local-chain/deploy-engine.ts`.
 *
 * Idempotent: while the manifest's asset still has code on the running chain,
 * the deployment is reused and the buyer is only topped up to the target.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEV_KEY_LABEL } from '../../src/payments/x402/local-chain/accounts';
import {
  assertNoUnknownDeployment,
  deployLocalChain,
  describeWellKnownAccounts,
} from '../../src/payments/x402/local-chain/deploy-engine';
import {
  LOCAL_CHAIN_MANIFEST_PATH,
  type LocalChainManifest,
} from '../../src/payments/x402/local-chain/manifest';

const DEFAULT_BUYER_INITIAL_BALANCE = '100.00';

async function main(): Promise<void> {
  const rpcUrl = process.env['X402_RPC_URL'] ?? 'http://127.0.0.1:8545';
  const manifestPath =
    process.env['LOCAL_CHAIN_MANIFEST'] ?? join(process.cwd(), LOCAL_CHAIN_MANIFEST_PATH);
  const buyerInitialBalance =
    process.env['X402_BUYER_INITIAL_BALANCE'] ?? DEFAULT_BUYER_INITIAL_BALANCE;

  const existingAsset = readExistingAssetAddress(manifestPath);

  // Refuses a silent second deployment when another deployer used this chain
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
    // Differs from rpcUrl only inside Docker, where HOST_RPC_URL names the
    // published port and rpcUrl the container address ("http://anvil:8545")
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
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    // The chain is deployed; only recording it failed. Under docker compose an
    // EACCES is almost always a uid mismatch between the container user
    // (`DOCKER_UID`, 1000 by default) and the checkout's owner, so the error
    // says that instead of leaving a raw EACCES that points at the chain.
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(
        `Cannot write the deployment manifest to ${manifestPath}: permission denied.\n` +
          'Under docker compose this means the chain-deploy container is running as a ' +
          'different user than the one that owns this checkout. Export your own ids and ' +
          'bring the stack up again:\n\n' +
          '  export DOCKER_UID="$(id -u)" DOCKER_GID="$(id -g)"\n' +
          '  docker compose up -d --build\n',
        { cause: err },
      );
    }
    throw err;
  }

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
