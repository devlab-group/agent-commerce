/**
 * Proof that a settlement happened, from on-chain state: ERC-20 balances and
 * transaction receipts, never the provider's own report of success
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, erc20Abi, http, type PublicClient } from 'viem';
import { expect } from 'vitest';

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

/** Reads the buyer's and merchant's current on-chain ERC-20 balances */
export async function readBalances(query: Erc20BalanceQuery): Promise<BalanceSnapshot> {
  const publicClient = client(query.rpcUrl);
  const [buyer, merchant] = await Promise.all([
    publicClient.readContract({
      address: query.asset,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [query.buyer],
    }),
    publicClient.readContract({
      address: query.asset,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [query.merchant],
    }),
  ]);
  return { buyer, merchant };
}

/** Asserts that the transaction exists on-chain and succeeded, not just that a hash came back */
export async function assertTransactionSucceeded(rpcUrl: string, txHash: string): Promise<void> {
  expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const publicClient = client(rpcUrl);
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  expect(receipt).toBeDefined();
  expect(receipt.status).toBe('success');
  expect(receipt.transactionHash.toLowerCase()).toBe(txHash.toLowerCase());
}

/** Asserts that settlement moved exactly `amountBaseUnits` from buyer to merchant */
export function assertBalanceDelta(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  amountBaseUnits: bigint,
): void {
  expect(before.buyer - after.buyer).toBe(amountBaseUnits);
  expect(after.merchant - before.merchant).toBe(amountBaseUnits);
}

/** Full settlement proof: exact balance deltas and a successful on-chain transaction */
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

/**
 * Polls balances until `predicate` holds or the timeout passes, and returns
 * the last snapshot read. It throws only when no snapshot was ever read. It
 * waits out a public RPC node that lags the facilitator's by a block or two;
 * callers still assert the exact delta. It reads every 6 s, because a public
 * endpoint may rate-limit a faster loop.
 */
export async function waitForBalances(
  query: Erc20BalanceQuery,
  predicate: (snapshot: BalanceSnapshot) => boolean,
  timeoutMs = 90_000,
): Promise<BalanceSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot: BalanceSnapshot | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      snapshot = await readBalances(query);
      lastError = undefined;
      if (predicate(snapshot)) return snapshot;
    } catch (err) {
      // A public RPC rate-limiting the poll is not evidence about the payment
      lastError = err;
    }
    await sleep(6_000);
  }
  if (snapshot) return snapshot;
  throw lastError ?? new Error('no balance snapshot was ever read');
}
