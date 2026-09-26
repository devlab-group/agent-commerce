/**
 * Deploys MockUSDC to the local chain and funds the demo accounts with viem and
 * the compiled artifact, so it runs from plain Node without `forge script`.
 * `scripts/chain/deploy.ts` and the tests use it; no package entry exports it.
 */
import { erc20Abi, formatUnits } from 'viem';
import { CommerceError } from '../../../core';
import { parseCanonicalAmount } from '../amount';
import { createLocalFacilitatorClient, createLocalPublicClient } from '../chain';
import { LOCAL_CHAIN_ID } from '../networks';
import {
  ANVIL_WELL_KNOWN_ACCOUNTS,
  DEV_KEY_LABEL,
  LOCAL_BUYER_ACCOUNT,
  LOCAL_FACILITATOR_ACCOUNT,
  LOCAL_MERCHANT_ACCOUNT,
} from './accounts';
import { loadMockUsdcArtifact } from './artifact';

const MOCK_USDC_NAME = 'MockUSDC';
const MOCK_USDC_VERSION = '2';
const MOCK_USDC_DECIMALS = 6;

// Native-gas top-up threshold. Anvil's default accounts start far above it, so
// it matters only for a non-default account or balance configuration.
const MIN_GAS_BALANCE_WEI = 1_000_000_000_000_000_000n; // 1 ETH
const GAS_TOP_UP_WEI = 10_000_000_000_000_000_000n; // 10 ETH

export interface DeployLocalChainOptions {
  readonly rpcUrl: string;
  /** Canonical decimal display amount, e.g. "100.00" */
  readonly buyerInitialBalance: string;
  readonly log?: (message: string) => void;
}

export interface DeployLocalChainResult {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly asset: `0x${string}`;
  readonly assetName: string;
  readonly assetVersion: string;
  readonly assetDecimals: number;
  readonly merchant: { readonly address: `0x${string}` };
  readonly buyer: { readonly address: `0x${string}`; readonly privateKey: `0x${string}` };
  readonly facilitator: { readonly address: `0x${string}`; readonly privateKey: `0x${string}` };
  readonly buyerInitialBalance: string;
  /** False when an existing deployment on the same running chain was reused */
  readonly freshlyDeployed: boolean;
}

export async function deployLocalChain(
  options: DeployLocalChainOptions,
  existingAsset?: `0x${string}`,
): Promise<DeployLocalChainResult> {
  const log = options.log ?? (() => {});
  const publicClient = createLocalPublicClient(options.rpcUrl);

  const chainId = await publicClient.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Local chain at ${options.rpcUrl} reports chain id ${chainId}, expected ${LOCAL_CHAIN_ID}. ` +
        'Start it with "npm run chain:start" (anvil --chain-id 84532 ...).',
    );
  }

  const facilitatorClient = createLocalFacilitatorClient(
    options.rpcUrl,
    LOCAL_FACILITATOR_ACCOUNT.privateKey,
  );

  let asset = existingAsset;
  let freshlyDeployed = false;

  if (asset) {
    const code = await publicClient.getCode({ address: asset });
    if (!code || code === '0x') {
      // The manifest names a deployment that is gone (anvil restarted), so
      // redeploy below
      asset = undefined;
    }
  }

  if (!asset) {
    log('Deploying MockUSDC...');
    const artifact = loadMockUsdcArtifact();
    const hash = await facilitatorClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new CommerceError(
        'INTERNAL_ERROR',
        `MockUSDC deployment transaction failed (tx ${hash}).`,
      );
    }
    asset = receipt.contractAddress;
    freshlyDeployed = true;
    log(`MockUSDC deployed at ${asset}`);
  } else {
    log(`Reusing existing MockUSDC deployment at ${asset}`);
  }

  // --- ensure gas for buyer and merchant ------------------------------------
  await ensureGas(facilitatorClient, publicClient, LOCAL_MERCHANT_ACCOUNT.address, log);
  await ensureGas(facilitatorClient, publicClient, LOCAL_BUYER_ACCOUNT.address, log);

  // --- mint buyer up to the target balance ---------------------------------
  const targetBaseUnits = parseCanonicalAmount(options.buyerInitialBalance, MOCK_USDC_DECIMALS);
  const currentBaseUnits = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [LOCAL_BUYER_ACCOUNT.address],
  });

  if (currentBaseUnits < targetBaseUnits) {
    const shortfall = targetBaseUnits - currentBaseUnits;
    log(
      `Minting ${formatUnits(shortfall, MOCK_USDC_DECIMALS)} ${MOCK_USDC_NAME} to buyer ` +
        `${LOCAL_BUYER_ACCOUNT.address} (top-up to ${options.buyerInitialBalance})`,
    );
    const mintAbi = [
      {
        type: 'function',
        name: 'mint',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [],
      },
    ] as const;
    const hash = await facilitatorClient.writeContract({
      address: asset,
      abi: mintAbi,
      functionName: 'mint',
      args: [LOCAL_BUYER_ACCOUNT.address, shortfall],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new CommerceError(
        'INTERNAL_ERROR',
        `Minting MockUSDC to the buyer failed (tx ${hash}).`,
      );
    }
  } else {
    log(`Buyer already holds >= ${options.buyerInitialBalance} ${MOCK_USDC_NAME}, skipping mint.`);
  }

  return {
    chainId: LOCAL_CHAIN_ID,
    rpcUrl: options.rpcUrl,
    asset,
    assetName: MOCK_USDC_NAME,
    assetVersion: MOCK_USDC_VERSION,
    assetDecimals: MOCK_USDC_DECIMALS,
    merchant: { address: LOCAL_MERCHANT_ACCOUNT.address },
    buyer: { address: LOCAL_BUYER_ACCOUNT.address, privateKey: LOCAL_BUYER_ACCOUNT.privateKey },
    facilitator: {
      address: LOCAL_FACILITATOR_ACCOUNT.address,
      privateKey: LOCAL_FACILITATOR_ACCOUNT.privateKey,
    },
    buyerInitialBalance: options.buyerInitialBalance,
    freshlyDeployed,
  };
}

async function ensureGas(
  facilitatorClient: ReturnType<typeof createLocalFacilitatorClient>,
  publicClient: ReturnType<typeof createLocalPublicClient>,
  address: `0x${string}`,
  log: (message: string) => void,
): Promise<void> {
  const balance = await publicClient.getBalance({ address });
  if (balance >= MIN_GAS_BALANCE_WEI) return;
  log(`Funding ${address} with gas (${DEV_KEY_LABEL})`);
  const hash = await facilitatorClient.sendTransaction({ to: address, value: GAS_TOP_UP_WEI });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Addresses only, for the deploy CLI's startup log. Never includes a private key */
export function describeWellKnownAccounts(): string {
  return ANVIL_WELL_KNOWN_ACCOUNTS.map((a, i) => `  (${i}) ${a.address}`).join('\n');
}

/**
 * Refuses when the caller knows no MockUSDC deployment (`existingAsset` is
 * absent) but the deployer account (index 0) has already sent transactions on
 * this chain. That means another deployer, such as the compose `chain-deploy`
 * service, used the chain first. A second deployment would get a different
 * address, and whatever is configured against the first would silently
 * disagree with the new manifest.
 *
 * The deploy CLI (`scripts/chain/deploy.ts`) enforces this; `deployLocalChain`
 * does not, because the E2E suites deploy a second MockUSDC on purpose for
 * their wrong-asset cases.
 */
export async function assertNoUnknownDeployment(
  rpcUrl: string,
  existingAsset: `0x${string}` | undefined,
): Promise<void> {
  if (existingAsset) return;

  const publicClient = createLocalPublicClient(rpcUrl);
  const deployerNonce = await publicClient.getTransactionCount({
    address: LOCAL_FACILITATOR_ACCOUNT.address,
  });
  if (deployerNonce === 0) return;

  throw new CommerceError(
    'CONFIG_INVALID',
    `Local facilitator account ${LOCAL_FACILITATOR_ACCOUNT.address} has already sent ` +
      `${deployerNonce} transaction(s) on ${rpcUrl}, but no known MockUSDC deployment was given. ` +
      'Refusing to deploy a second one: its address would not match what anything already ' +
      'configured against the existing deployment expects. Point LOCAL_CHAIN_MANIFEST at the ' +
      "manifest that already knows this chain's deployment (e.g. the one docker-compose's " +
      'chain-deploy service wrote) so this run can reuse it, or restart anvil for a fresh chain ' +
      '("npm run chain:start").',
  );
}
