/**
 * Deploys MockUSDC to the local deterministic chain and funds the demo
 * accounts, using `viem` directly against the compiled Foundry artifact (no
 * `forge script`, so this works from a plain Node process with no Foundry
 * broadcast state to manage).
 *
 * This module lives inside `src/payments/x402` because it is x402 local-chain
 * machinery, next to the facilitator and chain constants it shares. It is
 * deliberately *not* re-exported from the package's public `src/index.ts` —
 * deploying a mock token is a demo affordance, not part of the shipped API.
 * Only `scripts/chain/deploy.ts` imports it, by relative path.
 */
import { formatUnits } from 'viem';
import { parseCanonicalAmount } from '../amount.js';
import { createLocalFacilitatorClient, createLocalPublicClient, LOCAL_CHAIN_ID } from '../chain.js';
import {
  ANVIL_WELL_KNOWN_ACCOUNTS,
  DEV_KEY_LABEL,
  LOCAL_BUYER_ACCOUNT,
  LOCAL_FACILITATOR_ACCOUNT,
  LOCAL_MERCHANT_ACCOUNT,
} from './accounts.js';
import { loadMockUsdcArtifact } from './artifact.js';

const MOCK_USDC_NAME = 'MockUSDC';
const MOCK_USDC_VERSION = '2';
const MOCK_USDC_DECIMALS = 6;

/** Native-gas top-up threshold. Anvil funds its 10 default accounts with far
 * more than this out of the box; this only matters if someone runs anvil
 * with a non-default account/balance configuration. */
const MIN_GAS_BALANCE_WEI = 1_000_000_000_000_000_000n; // 1 ETH
const GAS_TOP_UP_WEI = 10_000_000_000_000_000_000n; // 10 ETH

export interface DeployLocalChainOptions {
  readonly rpcUrl: string;
  /** Canonical decimal display amount, e.g. "100.00". */
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
  /** False when an existing deployment on the same live chain was reused. */
  readonly freshlyDeployed: boolean;
}

const ERC20_READ_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export async function deployLocalChain(
  options: DeployLocalChainOptions,
  existingAsset?: `0x${string}`,
): Promise<DeployLocalChainResult> {
  const log = options.log ?? (() => {});
  const publicClient = createLocalPublicClient(options.rpcUrl);

  const chainId = await publicClient.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new Error(
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
      // Manifest pointed at a dead deployment (e.g. anvil was restarted) —
      // fall through and redeploy fresh below.
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
      throw new Error(`MockUSDC deployment transaction failed (tx ${hash}).`);
    }
    asset = receipt.contractAddress;
    freshlyDeployed = true;
    log(`MockUSDC deployed at ${asset}`);
  } else {
    log(`Reusing existing MockUSDC deployment at ${asset}`);
  }

  // --- ensure gas for buyer / merchant -------------------------------------
  await ensureGas(facilitatorClient, publicClient, LOCAL_MERCHANT_ACCOUNT.address, log);
  await ensureGas(facilitatorClient, publicClient, LOCAL_BUYER_ACCOUNT.address, log);

  // --- mint buyer up to the target balance ---------------------------------
  const targetBaseUnits = parseCanonicalAmount(options.buyerInitialBalance, MOCK_USDC_DECIMALS);
  const currentBaseUnits = (await publicClient.readContract({
    address: asset,
    abi: ERC20_READ_ABI,
    functionName: 'balanceOf',
    args: [LOCAL_BUYER_ACCOUNT.address],
  })) as bigint;

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
      throw new Error(`Minting MockUSDC to the buyer failed (tx ${hash}).`);
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

/** Exposed for the deploy CLI's startup log — never logs private key material. */
export function describeWellKnownAccounts(): string {
  return ANVIL_WELL_KNOWN_ACCOUNTS.map((a, i) => `  (${i}) ${a.address}`).join('\n');
}

/**
 * Refuses to proceed when the caller has no known MockUSDC deployment (no
 * `existingAsset`) but the facilitator key has already sent transactions on
 * this chain — the account is only ever used by the deploy CLI (see
 * accounts.ts: index 0 is "deployer / local facilitator signer"), so a
 * nonzero nonce with nothing to reuse means an independent deployer (e.g.
 * `docker compose up`'s own chain-deploy service) already used this exact
 * chain without this process knowing. Deploying blindly here would create a
 * second, differently-addressed MockUSDC via CREATE, and anything already
 * configured against the first deployment (a running gateway, a container's
 * own manifest) would keep pointing at it while this process's manifest
 * silently starts pointing at the new one — "doctor reports healthy against
 * the mismatched address" is the failure this refuses instead of causing.
 *
 * Deliberately NOT enforced inside `deployLocalChain` itself: that function
 * is also used by test/tooling code that legitimately deploys more than one
 * independent MockUSDC on the same chain on purpose (e.g. the E2E suite's
 * "wrong asset" case). This is opt-in policy for the CLI entry point only —
 * `scripts/chain/deploy.ts` — which is what an operator actually runs, and
 * the only place "an unexplained deployment already exists" should halt
 * rather than deploy silently.
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

  throw new Error(
    `Local facilitator account ${LOCAL_FACILITATOR_ACCOUNT.address} has already sent ` +
      `${deployerNonce} transaction(s) on ${rpcUrl}, but no known MockUSDC deployment was given. ` +
      'Refusing to deploy a second one — its address would not match what anything already ' +
      'configured against the existing deployment expects. Point LOCAL_CHAIN_MANIFEST at the ' +
      "manifest that already knows this chain's deployment (e.g. the one docker-compose's " +
      'chain-deploy service wrote) so this run can reuse it, or restart anvil for a genuinely ' +
      'fresh chain ("npm run chain:start").',
  );
}
