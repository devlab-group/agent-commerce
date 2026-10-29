/**
 * EVM reconciliation evidence for EIP-3009 (x402 and MPP) and Permit2 through
 * the x402 proxy.
 *
 * Definite outcomes require finalized evidence: `settled` needs a successful
 * receipt matching the authorization and transfer; `not-settled` needs unused
 * state after the authorization expires. Missing logs or receipts may reflect
 * RPC pruning, so they do not prove nonpayment. Other cases remain `unknown`.
 */
import { eip3009ABI, PERMIT2_ADDRESS, x402ExactPermit2ProxyABI } from '@x402/evm';
import {
  type Address,
  decodeFunctionData,
  type Hash,
  type Hex,
  isAddress,
  isAddressEqual,
  isHash,
  type PublicClient,
  parseAbi,
  parseEventLogs,
  TransactionReceiptNotFoundError,
} from 'viem';
import type { PaymentAttempt, PaymentReconciliationResult } from '../../../core';
import { isoFromSeconds } from '../locator';

const EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const NONCE_BITMAP_ABI = parseAbi([
  'function nonceBitmap(address owner, uint256 wordPosition) view returns (uint256)',
]);

// Allow for clock skew between the gateway and chain when setting the search
// window around the attempt's creation time
const CLOCK_MARGIN_SECONDS = 900n;
// Split log queries to limit the size of each RPC request
const LOG_CHUNK_BLOCKS = 10_000n;
const MAX_WINDOW_BLOCKS = 200_000n;

const UINT = /^\d{1,78}$/;

interface Eip3009Locator {
  readonly method: 'eip3009';
  readonly asset: Address;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly nonce: Hex;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly expiresAt: string | undefined;
}

interface Permit2Locator {
  readonly method: 'permit2';
  readonly asset: Address;
  readonly owner: Address;
  readonly to: Address;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly validAfter: bigint;
  readonly proxy: Address;
  readonly expiresAt: string | undefined;
}

export type EvmLocator = Eip3009Locator | Permit2Locator;

/**
 * Parses EVM transfer fields, or returns undefined if required fields are
 * missing or malformed
 */
export function parseEvmLocator(
  locator: Readonly<Record<string, unknown>>,
): EvmLocator | undefined {
  const address = (key: string) => {
    const value = locator[key];
    return typeof value === 'string' && isAddress(value) ? value : undefined;
  };
  const uint = (key: string) => {
    const value = locator[key];
    return typeof value === 'string' && UINT.test(value) ? BigInt(value) : undefined;
  };
  const expiresAt = typeof locator['expiresAt'] === 'string' ? locator['expiresAt'] : undefined;
  if (locator['method'] === 'eip3009') {
    const [asset, from, to] = [address('asset'), address('from'), address('to')];
    const [value, validAfter, validBefore] = [
      uint('value'),
      uint('validAfter'),
      uint('validBefore'),
    ];
    const nonce = locator['nonce'];
    if (!asset || !from || !to || value === undefined || validAfter === undefined) return undefined;
    if (validBefore === undefined || typeof nonce !== 'string' || !isHash(nonce)) return undefined;
    return { method: 'eip3009', asset, from, to, value, nonce, validAfter, validBefore, expiresAt };
  }
  if (locator['method'] === 'permit2') {
    const [asset, owner, to, proxy] = [
      address('asset'),
      address('owner'),
      address('to'),
      address('proxy'),
    ];
    const [amount, nonce, deadline, validAfter] = [
      uint('amount'),
      uint('nonce'),
      uint('deadline'),
      uint('validAfter'),
    ];
    if (!asset || !owner || !to || !proxy || amount === undefined || nonce === undefined) {
      return undefined;
    }
    if (deadline === undefined || validAfter === undefined) return undefined;
    return {
      method: 'permit2',
      asset,
      owner,
      to,
      amount,
      nonce,
      deadline,
      validAfter,
      proxy,
      expiresAt,
    };
  }
  return undefined;
}

// Evidence reads and validity bounds specific to each transfer method
interface Method {
  // Earliest timestamp at which the authorization has expired
  readonly endsAt: bigint;
  readonly validAfter: bigint;
  used(blockNumber?: bigint): Promise<boolean>;
  // Transactions in the range that may carry the transfer
  candidates(fromBlock: bigint, toBlock: bigint): Promise<readonly Hash[]>;
  // The receipt's block, when this transaction carried the transfer
  carries(hash: Hash): Promise<bigint | undefined>;
}

export interface EvmEvidenceInput {
  readonly client: PublicClient;
  readonly chainId: number;
  readonly locator: EvmLocator;
  readonly attempt: PaymentAttempt;
}

export async function readEvmEvidence(
  input: EvmEvidenceInput,
): Promise<PaymentReconciliationResult> {
  const { client, chainId, locator, attempt } = input;
  const reported = await client.getChainId();
  if (reported !== chainId) {
    return unknown('chain_mismatch', { chainId: reported, expectedChainId: chainId });
  }
  const finalized = await client.getBlock({ blockTag: 'finalized' });
  const finalizedAt = isoFromSeconds(String(finalized.timestamp));
  const finality = {
    finalizedBlock: String(finalized.number),
    ...(finalizedAt !== undefined ? { finalizedAt } : {}),
  };
  const method = locator.method === 'eip3009' ? eip3009(client, locator) : permit2(client, locator);
  const settled = (hash: Hash, block: bigint): PaymentReconciliationResult =>
    block <= finalized.number
      ? {
          outcome: 'settled',
          reason: 'transfer_final',
          externalReference: hash,
          evidence: { transactionHash: hash, blockNumber: String(block), ...finality },
        }
      : unknown('not_final', { transactionHash: hash, blockNumber: String(block), ...finality });

  const reference = attempt.externalReference;
  if (reference !== undefined && isHash(reference)) {
    const block = await method.carries(reference);
    if (block !== undefined) return settled(reference, block);
  }

  if (!(await method.used(finalized.number))) {
    if (finalized.timestamp >= method.endsAt) {
      return {
        outcome: 'not-settled',
        reason: 'expired_unused',
        evidence: { nonceUsed: false, ...finality },
      };
    }
    if (await method.used()) return unknown('not_final', finality);
    return {
      ...unknown('not_expired', finality),
      ...(locator.expiresAt !== undefined ? { retryAfter: locator.expiresAt } : {}),
    };
  }

  // Start at the later of validAfter and the attempt time minus the clock
  // margin, covering at most MAX_WINDOW_BLOCKS. If no match is found in a
  // truncated range, return search_window_too_wide.
  const createdAt = BigInt(Math.floor(Date.parse(attempt.createdAt) / 1000));
  const fromSeconds = max(method.validAfter, createdAt - CLOCK_MARGIN_SECONDS);
  const fromBlock = await firstBlockAt(client, fromSeconds, finalized);
  const endBlock = (await firstBlockAt(client, method.endsAt, finalized)) - 1n;
  const toBlock = min(endBlock, fromBlock + MAX_WINDOW_BLOCKS - 1n);
  const window = { fromBlock: String(fromBlock), toBlock: String(toBlock), ...finality };
  for (const [start, end] of logRanges(fromBlock, toBlock)) {
    for (const hash of await method.candidates(start, end)) {
      const block = await method.carries(hash);
      if (block !== undefined) return settled(hash, block);
    }
  }
  if (toBlock < endBlock) {
    return unknown('search_window_too_wide', { ...window, endBlock: String(endBlock) });
  }
  // A cancelled authorization or invalidated nonce, a transfer through another
  // contract, or logs the RPC no longer serves
  return unknown('used_without_record', { nonceUsed: true, ...window });
}

function eip3009(client: PublicClient, locator: Eip3009Locator): Method {
  const { asset, from, to, value, nonce } = locator;
  return {
    endsAt: locator.validBefore,
    validAfter: locator.validAfter,
    used: (blockNumber) =>
      client.readContract({
        address: asset,
        abi: eip3009ABI,
        functionName: 'authorizationState',
        args: [from, nonce],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      }),
    async candidates(fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: asset,
        event: EVENTS[0],
        args: { authorizer: from, nonce },
        fromBlock,
        toBlock,
      });
      return logs.map((log) => log.transactionHash);
    },
    async carries(hash) {
      const receipt = await receiptOf(client, hash);
      if (receipt?.status !== 'success') return undefined;
      const logs = parseEventLogs({ abi: EVENTS, logs: receipt.logs }).filter((log) =>
        isAddressEqual(log.address, asset),
      );
      const used = logs.some(
        (log) =>
          log.eventName === 'AuthorizationUsed' &&
          isAddressEqual(log.args.authorizer, from) &&
          log.args.nonce.toLowerCase() === nonce.toLowerCase(),
      );
      return used && logs.some((log) => isTransfer(log, from, to, value))
        ? receipt.blockNumber
        : undefined;
    },
  };
}

function permit2(client: PublicClient, locator: Permit2Locator): Method {
  const { asset, owner, to, amount, nonce, proxy } = locator;
  return {
    // Permit2 accepts a transfer while the timestamp is at most the deadline
    endsAt: locator.deadline + 1n,
    validAfter: locator.validAfter,
    async used(blockNumber) {
      const bitmap = await client.readContract({
        address: PERMIT2_ADDRESS,
        abi: NONCE_BITMAP_ABI,
        functionName: 'nonceBitmap',
        args: [owner, nonce >> 8n],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
      return ((bitmap >> (nonce & 0xffn)) & 1n) === 1n;
    },
    // Match the nonce in proxy calldata to distinguish transfers with the
    // same owner, recipient and amount
    async candidates(fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: asset,
        event: EVENTS[1],
        args: { from: owner, to },
        fromBlock,
        toBlock,
      });
      // ponytail: each candidate needs receipt and transaction reads; cap these for busy payers
      return [...new Set(logs.map((log) => log.transactionHash))];
    },
    async carries(hash) {
      const receipt = await receiptOf(client, hash);
      if (receipt?.status !== 'success' || !receipt.to || !isAddressEqual(receipt.to, proxy)) {
        return undefined;
      }
      // Only direct proxy calls are decoded; indirect calls remain unresolved
      const call = proxyCall((await client.getTransaction({ hash })).input);
      const named =
        call !== undefined &&
        isAddressEqual(call.owner, owner) &&
        call.nonce === nonce &&
        isAddressEqual(call.asset, asset) &&
        isAddressEqual(call.to, to);
      const transferred = parseEventLogs({ abi: EVENTS, logs: receipt.logs }).some(
        (log) => isAddressEqual(log.address, asset) && isTransfer(log, owner, to, amount),
      );
      return named && transferred ? receipt.blockNumber : undefined;
    },
  };
}

/** Decodes the owner, nonce, asset and recipient from a direct x402 Permit2 proxy call */
export function proxyCall(input: Hex) {
  let call: ReturnType<typeof decodeProxyInput>;
  try {
    call = decodeProxyInput(input);
  } catch {
    return undefined;
  }
  const parts =
    call.functionName === 'settle'
      ? call.args
      : call.functionName === 'settleWithPermit'
        ? ([call.args[1], call.args[2], call.args[3]] as const)
        : undefined;
  if (parts === undefined) return undefined;
  const [permit, owner, witness] = parts;
  return { owner, nonce: permit.nonce, asset: permit.permitted.token, to: witness.to };
}

const decodeProxyInput = (data: Hex) => decodeFunctionData({ abi: x402ExactPermit2ProxyABI, data });

type EventLog = ReturnType<typeof parseEventLogs<typeof EVENTS>>[number];

function isTransfer(log: EventLog, from: Address, to: Address, value: bigint): boolean {
  return (
    log.eventName === 'Transfer' &&
    isAddressEqual(log.args.from, from) &&
    isAddressEqual(log.args.to, to) &&
    log.args.value === value
  );
}

async function receiptOf(client: PublicClient, hash: Hash) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return undefined;
    throw err;
  }
}

/** Splits `fromBlock` through `toBlock` into inclusive ranges for separate `getLogs` requests */
export function logRanges(fromBlock: bigint, toBlock: bigint): [bigint, bigint][] {
  const ranges: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    ranges.push([start, min(start + LOG_CHUNK_BLOCKS - 1n, toBlock)]);
  }
  return ranges;
}

/**
 * Returns the first block number up to the finalized head whose timestamp
 * reaches `seconds`, or the number after that head if none does. Alternates
 * timestamp interpolation with bisection to bound the search.
 */
export async function firstBlockAt(
  client: Pick<PublicClient, 'getBlock'>,
  seconds: bigint,
  finalized: { readonly number: bigint; readonly timestamp: bigint },
): Promise<bigint> {
  if (seconds > finalized.timestamp) return finalized.number + 1n;
  const timestampOf = async (blockNumber: bigint) =>
    (await client.getBlock({ blockNumber })).timestamp;
  let low = 0n;
  let lowTime = await timestampOf(low);
  if (lowTime >= seconds) return 0n;
  // Keep low before the target timestamp and high at or after it
  let high = finalized.number;
  let highTime = finalized.timestamp;
  for (let step = 0; high - low > 1n; step++) {
    let middle = (low + high) / 2n;
    if (step % 2 === 0 && highTime > lowTime) {
      const guess = low + ((seconds - lowTime) * (high - low)) / (highTime - lowTime);
      middle = min(max(guess, low + 1n), high - 1n);
    }
    const timestamp = await timestampOf(middle);
    if (timestamp >= seconds) [high, highTime] = [middle, timestamp];
    else [low, lowTime] = [middle, timestamp];
  }
  return high;
}

/** An `unknown` answer with its reason and optional evidence */
export function unknown(
  reason: string,
  evidence?: Readonly<Record<string, unknown>>,
): PaymentReconciliationResult {
  return { outcome: 'unknown', reason, ...(evidence !== undefined ? { evidence } : {}) };
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
