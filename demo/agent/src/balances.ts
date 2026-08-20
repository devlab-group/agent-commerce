/**
 * On-chain ERC-20 (MockUSDC) balance reads.
 *
 * The demo's actual proof of settlement is a balance delta, not an HTTP
 * status — see run.ts. Reads go straight to the local Anvil chain via the
 * RPC URL in `.deploy/local.json`, never through the gateway.
 */
import { createPublicClient, formatUnits, http, parseUnits } from 'viem';

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface BalanceReader {
  read(address: `0x${string}`): Promise<bigint>;
}

export function createBalanceReader(rpcUrl: string, assetAddress: `0x${string}`): BalanceReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async read(address: `0x${string}`): Promise<bigint> {
      return client.readContract({
        address: assetAddress,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [address],
      });
    },
  };
}

/** Formats a base-unit balance as a human decimal string, e.g. 10000n, 6 -> "0.01". */
export function formatAssetAmount(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/** Parses a canonical decimal amount (e.g. "0.01") into base units. */
export function parseAssetAmount(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}
