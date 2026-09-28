/**
 * ERC-20 (MockUSDC) balance reads. A balance delta, not an HTTP status, is the
 * demo's proof of settlement (see run.ts). Reads go straight to the chain RPC,
 * never through the gateway.
 */
import { createPublicClient, erc20Abi, http } from 'viem';

export interface BalanceReader {
  read(address: `0x${string}`): Promise<bigint>;
}

export function createBalanceReader(rpcUrl: string, assetAddress: `0x${string}`): BalanceReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async read(address: `0x${string}`): Promise<bigint> {
      return client.readContract({
        address: assetAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
    },
  };
}
