import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalFacilitatorClient } from '../../../src/payments/x402/chain.js';
import {
  ANVIL_WELL_KNOWN_ACCOUNTS,
  DEV_KEY_LABEL,
  LOCAL_BUYER_ACCOUNT,
  LOCAL_FACILITATOR_ACCOUNT,
} from '../../../src/payments/x402/local-chain/accounts.js';
import { type AnvilHandle, startAnvil } from '../../../src/payments/x402/local-chain/anvil.js';
import {
  buildFreshArtifactViaForge,
  isForgeAvailable,
  loadMockUsdcArtifact,
  readCommittedArtifactIfPresent,
} from '../../../src/payments/x402/local-chain/artifact.js';
import {
  assertNoUnknownDeployment,
  deployLocalChain,
  describeWellKnownAccounts,
} from '../../../src/payments/x402/local-chain/deploy-engine.js';

// These tests exercise the *real* deploy engine against a real, ephemeral,
// local Anvil process (not a mock) — it is deployment tooling, not business
// logic, and the only honest way to cover it is to actually run it. This is
// still a "unit"-tier test: the chain is private to this test file, started
// and torn down here, never touching a public network.

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

describe('local-chain well-known accounts', () => {
  it('has exactly 3 accounts with distinct addresses', () => {
    expect(ANVIL_WELL_KNOWN_ACCOUNTS).toHaveLength(3);
    const addresses = new Set(ANVIL_WELL_KNOWN_ACCOUNTS.map((a) => a.address));
    expect(addresses.size).toBe(3);
  });

  it('labels every dev key as local-development-only', () => {
    expect(DEV_KEY_LABEL).toMatch(/LOCAL DEVELOPMENT ONLY/);
    expect(DEV_KEY_LABEL).toMatch(/DO NOT FUND/);
  });

  it('describeWellKnownAccounts() lists every address and never leaks a private key', () => {
    const description = describeWellKnownAccounts();
    for (const account of ANVIL_WELL_KNOWN_ACCOUNTS) {
      expect(description).toContain(account.address);
      expect(description).not.toContain(account.privateKey);
    }
  });
});

describe('MockUSDC artifact', () => {
  it('loads the compiled artifact with both transferWithAuthorization overloads', () => {
    const artifact = loadMockUsdcArtifact();
    expect(Array.isArray(artifact.abi)).toBe(true);
    expect(artifact.bytecode.startsWith('0x')).toBe(true);

    const overloads = artifact.abi.filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { name?: string }).name === 'transferWithAuthorization',
    );
    expect(overloads).toHaveLength(2);
  });

  // Guards against the committed contracts/artifacts/MockUSDC.json (the
  // fallback Docker's chain-deploy step uses, since that image has no
  // Foundry) silently rotting when MockUSDC.sol changes. Skips gracefully
  // when forge isn't installed; must run in CI, where it is.
  it.runIf(isForgeAvailable())(
    'committed artifact matches a fresh forge build (regenerate with "npx tsx scripts/chain/build-artifact.ts" if this fails)',
    () => {
      const committed = readCommittedArtifactIfPresent();
      expect(committed).toBeDefined();
      const fresh = buildFreshArtifactViaForge();
      expect(committed?.bytecode).toBe(fresh.bytecode);
      expect(committed?.abi).toEqual(fresh.abi);
    },
  );
});

describe('deployLocalChain (real ephemeral anvil)', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvil({ port: 18713, silent: true });
  }, 30_000);

  afterAll(async () => {
    await anvil.stop();
  });

  async function balanceOf(asset: `0x${string}`, address: `0x${string}`): Promise<bigint> {
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    return client.readContract({
      address: asset,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
  }

  it('deploys fresh, mints exactly the target buyer balance, and reports freshlyDeployed', async () => {
    const result = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '10.00' });
    expect(result.freshlyDeployed).toBe(true);
    expect(result.chainId).toBe(84532);
    expect(result.assetDecimals).toBe(6);
    expect(result.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(await balanceOf(result.asset, result.buyer.address)).toBe(10_000_000n);
  }, 30_000);

  it('reuses an existing live deployment instead of redeploying, and tops up on a higher target', async () => {
    const first = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '10.00' });

    const reused = await deployLocalChain(
      { rpcUrl: anvil.rpcUrl, buyerInitialBalance: '10.00' },
      first.asset,
    );
    expect(reused.freshlyDeployed).toBe(false);
    expect(reused.asset).toBe(first.asset);
    expect(await balanceOf(reused.asset, reused.buyer.address)).toBe(10_000_000n); // unchanged, already at target

    const toppedUp = await deployLocalChain(
      { rpcUrl: anvil.rpcUrl, buyerInitialBalance: '25.00' },
      first.asset,
    );
    expect(toppedUp.freshlyDeployed).toBe(false);
    expect(await balanceOf(toppedUp.asset, toppedUp.buyer.address)).toBe(25_000_000n);
  }, 30_000);

  it('falls back to a fresh deployment when the given asset address has no code (e.g. chain was restarted)', async () => {
    const deadAddress = '0x000000000000000000000000000000000000dEaD' as const;
    const result = await deployLocalChain(
      { rpcUrl: anvil.rpcUrl, buyerInitialBalance: '5.00' },
      deadAddress,
    );
    expect(result.freshlyDeployed).toBe(true);
    expect(result.asset).not.toBe(deadAddress);
  }, 30_000);

  it('returns the well-known deployer/merchant/buyer addresses in their documented index order', async () => {
    const result = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '1.00' });
    expect(result.merchant.address).toBe(ANVIL_WELL_KNOWN_ACCOUNTS[1]?.address);
    expect(result.buyer.address).toBe(ANVIL_WELL_KNOWN_ACCOUNTS[2]?.address);
    expect(result.facilitator.address).toBe(ANVIL_WELL_KNOWN_ACCOUNTS[0]?.address);
  }, 30_000);
});

describe('deployLocalChain — wrong chain id', () => {
  it('rejects when pointed at a chain that is not id 84532', async () => {
    const wrongChain = await startAnvil({ port: 18714, chainId: 31337, silent: true });
    try {
      await expect(
        deployLocalChain({ rpcUrl: wrongChain.rpcUrl, buyerInitialBalance: '1.00' }),
      ).rejects.toThrow(/chain id/);
    } finally {
      await wrongChain.stop();
    }
  }, 30_000);
});

describe('assertNoUnknownDeployment', () => {
  // The CLI-only guard (see its own doc comment in deploy-engine.ts) against
  // the failure dx's investigation found: running `npm run chain:deploy` on the
  // host while a dockerised stack already deployed to the same chain, with
  // no local manifest to tell this process about it — which used to deploy a
  // second, differently-addressed MockUSDC silently. Not exercised through
  // deployLocalChain itself, which legitimately deploys more than one
  // independent token on purpose elsewhere (e.g. the E2E "wrong asset" case).
  it('does nothing when an existingAsset is already known, regardless of nonce', async () => {
    const freshChain = await startAnvil({ port: 18715, silent: true });
    try {
      await expect(
        assertNoUnknownDeployment(freshChain.rpcUrl, '0x000000000000000000000000000000000000dEaD'),
      ).resolves.toBeUndefined();
    } finally {
      await freshChain.stop();
    }
  }, 30_000);

  it('does nothing on a genuinely fresh chain (facilitator nonce 0) even with no existingAsset', async () => {
    const freshChain = await startAnvil({ port: 18716, silent: true });
    try {
      await expect(
        assertNoUnknownDeployment(freshChain.rpcUrl, undefined),
      ).resolves.toBeUndefined();
    } finally {
      await freshChain.stop();
    }
  }, 30_000);

  it('throws when the facilitator key has already transacted on this chain and no existingAsset is known', async () => {
    const freshChain = await startAnvil({ port: 18717, silent: true });
    try {
      // Simulate an independent deployer having already used this exact
      // chain (e.g. docker-compose's own chain-deploy step) without this
      // process's manifest knowing about it.
      const facilitatorClient = createLocalFacilitatorClient(
        freshChain.rpcUrl,
        LOCAL_FACILITATOR_ACCOUNT.privateKey,
      );
      const publicClient = createPublicClient({ transport: http(freshChain.rpcUrl) });
      const hash = await facilitatorClient.sendTransaction({
        to: LOCAL_BUYER_ACCOUNT.address,
        value: 1n,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      await expect(assertNoUnknownDeployment(freshChain.rpcUrl, undefined)).rejects.toThrow(
        /already sent/,
      );
    } finally {
      await freshChain.stop();
    }
  }, 30_000);
});
