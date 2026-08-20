/**
 * Reusable "prove a real settlement happened" helper.
 *
 * A console message saying "payment successful" is not proof: the provider can
 * report success while nothing moved on-chain. This module reads actual
 * ERC-20 balances and actual transaction receipts, so the payment E2E suite —
 * and any later cross-area E2E that reuses it — asserts real settlement state
 * rather than a self-reported one.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { expect } from 'vitest';

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface Erc20BalanceQuery {
  readonly rpcUrl: string;
  readonly asset: `0x${string}`;
  readonly buyer: `0x${string}`;
  readonly merchant: `0x${string}`;
}

export interface BalanceSnapshot {
  readonly buyer: bigint;
  readonly merchant: bigint;
}

function client(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) });
}

/** Reads the buyer's and merchant's current on-chain ERC-20 balances. */
export async function readBalances(query: Erc20BalanceQuery): Promise<BalanceSnapshot> {
  const publicClient = client(query.rpcUrl);
  const [buyer, merchant] = await Promise.all([
    publicClient.readContract({
      address: query.asset,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [query.buyer],
    }),
    publicClient.readContract({
      address: query.asset,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [query.merchant],
    }),
  ]);
  return { buyer, merchant };
}

/**
 * Asserts a real, on-chain transaction exists and succeeded — not merely
 * that some string looking like a hash was returned.
 */
export async function assertTransactionSucceeded(rpcUrl: string, txHash: string): Promise<void> {
  expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const publicClient = client(rpcUrl);
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  expect(receipt).toBeDefined();
  expect(receipt.status).toBe('success');
  expect(receipt.transactionHash.toLowerCase()).toBe(txHash.toLowerCase());
}

/**
 * Asserts that settlement moved *exactly* `amountBaseUnits` from buyer to
 * merchant — buyer down, merchant up, by the same amount, no more, no less.
 */
export function assertBalanceDelta(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  amountBaseUnits: bigint,
): void {
  expect(before.buyer - after.buyer).toBe(amountBaseUnits);
  expect(after.merchant - before.merchant).toBe(amountBaseUnits);
}

/**
 * Full settlement proof in one call: real balance deltas AND a real,
 * successful on-chain transaction.
 */
export async function expectRealSettlement(options: {
  readonly rpcUrl: string;
  readonly asset: `0x${string}`;
  readonly buyer: `0x${string}`;
  readonly merchant: `0x${string}`;
  readonly before: BalanceSnapshot;
  readonly after: BalanceSnapshot;
  readonly amountBaseUnits: bigint;
  readonly txHash: string;
}): Promise<void> {
  assertBalanceDelta(options.before, options.after, options.amountBaseUnits);
  await assertTransactionSucceeded(options.rpcUrl, options.txHash);
}
