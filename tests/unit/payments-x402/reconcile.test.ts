// EVM, Solana and NEAR input checks, log-query ranges and proxy calldata
import { x402ExactPermit2ProxyABI } from '@x402/evm';
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  type PublicClient,
  parseAbi,
  TransactionReceiptNotFoundError,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentAttempt, PaymentProvider } from '../../../src/core';
import { eip3009Locator, permit2Locator } from '../../../src/payments/x402/locator';
import { createX402PaymentProvider } from '../../../src/payments/x402/provider';
import {
  firstBlockAt,
  logRanges,
  parseEvmLocator,
  proxyCall,
  readEvmEvidence,
} from '../../../src/payments/x402/reconcile/evm';

const ASSET = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const BUYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
// Use a merchant address outside Anvil's published account set
const MERCHANT = '0x1111111111111111111111111111111111111111';
const PROXY = '0x402085c248eea27d92e8b30b2c58ed07f9e20001';

const ATTEMPT: PaymentAttempt = {
  id: 'pa_1',
  requestId: 'req_1',
  resourceId: 'demo.report',
  provider: 'x402',
  replayKey: 'replay_1',
  status: 'settlement-uncertain',
  amount: '0.01',
  currency: 'USDC',
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
};

// These input checks return before reading the configured Base Sepolia RPC
const provider = createX402PaymentProvider({
  network: 'eip155:84532',
  rpcUrl: 'http://127.0.0.1:9',
  asset: ASSET,
  assetName: 'USDC',
  assetVersion: '2',
  assetDecimals: 6,
  payTo: MERCHANT,
  facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
});

const EIP3009 = eip3009Locator('eip155:8453', ASSET, {
  from: BUYER,
  to: MERCHANT,
  value: '10000',
  validAfter: '0',
  validBefore: '1767225600',
  nonce: `0x${'ab'.repeat(32)}`,
});
const PERMIT2 = permit2Locator('eip155:8453', {
  asset: ASSET,
  owner: BUYER,
  to: MERCHANT,
  amount: '10000',
  nonce: '7',
  deadline: '1767225600',
  validAfter: '0',
  proxy: PROXY,
});

// Solana and NEAR locator shapes from payment verification
const SOLANA = {
  v: 1,
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  messageHash: `${'A'.repeat(43)}=`,
  recentBlockhash: '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn',
  payer: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
};
const NEAR = {
  v: 1,
  network: 'near:mainnet',
  senderId: 'buyer.near',
  publicKey: 'ed25519:47unvknMVQJ87USpHGn1uxXMQXZKEi9Wjnzvw18FAph6',
  nonce: '4000001',
  maxBlockHeight: '42',
  asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  receiver: 'merchant.near',
  amount: '1000000',
  relayers: ['relayer.near'],
};

function reconcile(locator: Readonly<Record<string, unknown>> | undefined, from = provider) {
  const read = (from as PaymentProvider).reconcile;
  if (read === undefined) throw new Error('the provider has no reconcile');
  return read({
    attempt: ATTEMPT,
    ...(locator !== undefined ? { locator } : {}),
    now: '2026-10-28T12:30:00.000Z',
  });
}

describe('x402 reconcile gates', () => {
  it('answers no_locator for an attempt written before locators', async () => {
    expect(await reconcile(undefined)).toEqual({ outcome: 'unknown', reason: 'no_locator' });
  });

  it('answers unsupported_locator_version for another version', async () => {
    expect(await reconcile({ ...EIP3009, v: 2 })).toEqual({
      outcome: 'unknown',
      reason: 'unsupported_locator_version',
    });
  });

  it.each([
    ['another chain family', { v: 1, network: 'cosmos:cosmoshub-4' }],
    ['a locator without a network', { v: 1 }],
  ])('answers unsupported_family for %s', async (_label, locator) => {
    expect(await reconcile(locator)).toEqual({ outcome: 'unknown', reason: 'unsupported_family' });
  });

  it.each([
    ['EIP-3009', EIP3009],
    ['Permit2', PERMIT2],
    ['Solana', SOLANA],
    ['NEAR', NEAR],
  ])(
    'reads a %s locator as verify writes it, then needs its network configured',
    async (_label, locator) => {
      expect(await reconcile(locator)).toEqual({
        outcome: 'unknown',
        reason: 'network_not_configured',
        evidence: { network: locator['network'] },
      });
    },
  );

  it.each([
    ['an unknown method', { ...EIP3009, method: 'transfer' }],
    ['a short EIP-3009 nonce', { ...EIP3009, nonce: '0xab' }],
    ['a malformed payer', { ...EIP3009, from: 'buyer' }],
    ['a hex value', { ...EIP3009, value: '0x10' }],
    ['a missing validBefore', { ...EIP3009, validBefore: undefined }],
    ['a negative amount', { ...PERMIT2, amount: '-1' }],
    ['a hex Permit2 nonce', { ...PERMIT2, nonce: '0x07' }],
    ['a malformed proxy', { ...PERMIT2, proxy: '0x1234' }],
    ['a missing deadline', { ...PERMIT2, deadline: undefined }],
    ['a Solana message hash that is not base64 SHA-256', { ...SOLANA, messageHash: 'abc' }],
    ['a short Solana blockhash', { ...SOLANA, recentBlockhash: '1111' }],
    ['a Solana payer outside base58', { ...SOLANA, payer: `0${'1'.repeat(43)}` }],
    ['a missing NEAR sender', { ...NEAR, senderId: undefined }],
    ['an empty NEAR public key', { ...NEAR, publicKey: '' }],
    ['a hex NEAR nonce', { ...NEAR, nonce: '0x10' }],
    ['a negative NEAR amount', { ...NEAR, amount: '-1' }],
    ['a NEAR maxBlockHeight past 20 digits', { ...NEAR, maxBlockHeight: '1'.repeat(21) }],
    ['NEAR relayers that are not a list', { ...NEAR, relayers: 'relayer.near' }],
    ['a NEAR relayer that is not a string', { ...NEAR, relayers: [7] }],
  ])('answers invalid_locator for %s', async (_label, locator) => {
    expect(await reconcile(locator)).toEqual({ outcome: 'unknown', reason: 'invalid_locator' });
  });
});

describe('logRanges', () => {
  it.each([
    ['one block', 5n, 5n, [[5n, 5n]]],
    ['exactly one range', 0n, 9_999n, [[0n, 9_999n]]],
    [
      'one block past a range',
      0n,
      10_000n,
      [
        [0n, 9_999n],
        [10_000n, 10_000n],
      ],
    ],
    [
      'an offset start',
      7n,
      25_006n,
      [
        [7n, 10_006n],
        [10_007n, 20_006n],
        [20_007n, 25_006n],
      ],
    ],
    ['an empty window', 9n, 8n, []],
  ])('covers %s with ranges of at most 10k blocks', (_label, from, to, ranges) => {
    expect(logRanges(from, to)).toEqual(ranges);
  });
});

describe('proxyCall', () => {
  const permit = {
    permitted: { token: getAddress(ASSET), amount: 10_000n },
    nonce: 7n,
    deadline: 9n,
  };
  const witness = { to: getAddress(MERCHANT), validAfter: 0n };
  const signature = `0x${'11'.repeat(65)}` as const;
  const named = {
    owner: getAddress(BUYER),
    nonce: 7n,
    asset: getAddress(ASSET),
    to: getAddress(MERCHANT),
  };

  it('reads settle', () => {
    const data = encodeFunctionData({
      abi: x402ExactPermit2ProxyABI,
      functionName: 'settle',
      args: [permit, getAddress(BUYER), witness, signature],
    });
    expect(proxyCall(data)).toEqual(named);
  });

  it('reads settleWithPermit, which carries an EIP-2612 permit first', () => {
    const permit2612 = {
      value: 10_000n,
      deadline: 9n,
      r: `0x${'22'.repeat(32)}`,
      s: `0x${'33'.repeat(32)}`,
      v: 27,
    } as const;
    const data = encodeFunctionData({
      abi: x402ExactPermit2ProxyABI,
      functionName: 'settleWithPermit',
      args: [permit2612, permit, getAddress(BUYER), witness, signature],
    });
    expect(proxyCall(data)).toEqual(named);
  });

  it.each([
    [
      'another proxy function',
      encodeFunctionData({ abi: x402ExactPermit2ProxyABI, functionName: 'PERMIT2' }),
    ],
    ['calldata the proxy does not define', '0xdeadbeef' as const],
  ])('names nothing for %s', (_label, data) => {
    expect(proxyCall(data)).toBeUndefined();
  });
});

// A chain whose block timestamps come from `timeOf`, counting block reads
function fakeChain(head: bigint, timeOf: (block: bigint) => bigint) {
  const getBlock = vi.fn(async (args: { blockNumber?: bigint; blockTag?: string }) => {
    const number = args.blockTag === 'finalized' ? head : (args.blockNumber ?? head);
    return { number, timestamp: timeOf(number) };
  });
  return { getBlock, finalized: { number: head, timestamp: timeOf(head) } };
}

describe('firstBlockAt', () => {
  // Reference answer by linear scan
  const scan = (head: bigint, timeOf: (block: bigint) => bigint, seconds: bigint) => {
    for (let block = 0n; block <= head; block++) if (timeOf(block) >= seconds) return block;
    return head + 1n;
  };

  it.each([
    ['uniform', (b: bigint) => 1_000n + 2n * b],
    ['irregular', (b: bigint) => 1_000n + b * b + (b % 7n === 0n ? 3n : 0n)],
    ['bursts of equal timestamps', (b: bigint) => 1_000n + (b / 10n) * 12n],
    ['genesis far in the past', (b: bigint) => (b === 0n ? 0n : 1_700_000_000n + b)],
  ])('matches a linear scan on %s timestamps', async (_label, timeOf) => {
    const head = 300n;
    const { getBlock, finalized } = fakeChain(head, timeOf);
    for (const seconds of [
      0n,
      timeOf(1n),
      timeOf(150n) - 1n,
      timeOf(150n),
      timeOf(head),
      timeOf(head) + 1n,
    ]) {
      expect(await firstBlockAt({ getBlock } as unknown as PublicClient, seconds, finalized)).toBe(
        scan(head, timeOf, seconds),
      );
    }
  });

  it('finds a block on a long uniform chain in a few reads', async () => {
    const timeOf = (b: bigint) => 1_600_000_000n + 2n * b;
    const { getBlock, finalized } = fakeChain(37_000_000n, timeOf);

    const block = await firstBlockAt(
      { getBlock } as unknown as PublicClient,
      timeOf(30_000_000n) - 1n,
      finalized,
    );

    expect(block).toBe(30_000_000n);
    expect(getBlock.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe('readEvmEvidence search window', () => {
  const timeOf = (b: bigint) => 1_600_000_000n + 2n * b;
  const head = 40_000_000n;
  // 900 s of clock margin at 2 s per block
  const fromBlock = 30_000_000n - 450n;
  const lastSearched = fromBlock + 200_000n - 1n;

  // Search for a used nonce with no matching log, from an attempt created at
  // block 30,000,000, for an authorization valid before `validBefore`
  async function searchUntil(validBefore: bigint) {
    const { getBlock } = fakeChain(head, timeOf);
    const getLogs = vi.fn(async (_range: { fromBlock: bigint; toBlock: bigint }) => []);
    const client = {
      getChainId: async () => 8453,
      getBlock,
      // The nonce is used
      readContract: async () => true,
      getLogs,
    } as unknown as PublicClient;
    const locator = parseEvmLocator(
      eip3009Locator('eip155:8453', ASSET, {
        from: BUYER,
        to: MERCHANT,
        value: '10000',
        validAfter: '0',
        validBefore: String(validBefore),
        nonce: `0x${'ab'.repeat(32)}`,
      }),
    );
    const createdAt = new Date(Number(timeOf(30_000_000n)) * 1000).toISOString();
    if (locator === undefined) throw new Error('the locator did not parse');
    const result = await readEvmEvidence({
      client,
      chainId: 8453,
      locator,
      attempt: { ...ATTEMPT, createdAt },
    });
    return { result, getLogs };
  }

  it('searches the first blocks after creation for a long-lived authorization', async () => {
    // Far beyond the finalized head
    const { result, getLogs } = await searchUntil(99_999_999_999n);

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'search_window_too_wide',
      evidence: {
        fromBlock: String(fromBlock),
        toBlock: String(lastSearched),
        endBlock: String(head),
      },
    });
    expect(getLogs).toHaveBeenCalledTimes(20);
    expect(getLogs.mock.calls.at(-1)?.[0]).toMatchObject({ toBlock: lastSearched });
  });

  it('reports the nonce used without a record when the validity ends at the search cap', async () => {
    // The last block before validBefore is the last block searched
    const { result } = await searchUntil(timeOf(lastSearched + 1n));

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'used_without_record',
      evidence: { fromBlock: String(fromBlock), toBlock: String(lastSearched) },
    });
  });

  it('reports the window too wide when the validity ends one block past the cap', async () => {
    const { result } = await searchUntil(timeOf(lastSearched + 2n));

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'search_window_too_wide',
      evidence: { toBlock: String(lastSearched), endBlock: String(lastSearched + 1n) },
    });
  });
});

describe('readEvmEvidence verdicts', () => {
  const FINAL = 1_000n;
  const timeAt = (b: bigint) => 1_700_000_000n + 2n * b;
  const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
  const TX: Hash = `0x${'cd'.repeat(32)}`;
  const OTHER: Hash = `0x${'ef'.repeat(32)}`;
  const NONCE: Hex = `0x${'ab'.repeat(32)}`;
  // The standard events a token emits for an EIP-3009 transfer
  const EVENTS = parseAbi([
    'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  const usedLog = (authorizer: Address, nonce: Hex, address: Address = ASSET) => ({
    address,
    topics: encodeEventTopics({
      abi: EVENTS,
      eventName: 'AuthorizationUsed',
      args: { authorizer, nonce },
    }),
    data: '0x' as Hex,
  });
  const transferLog = (from: Address, to: Address, value: bigint, address: Address = ASSET) => ({
    address,
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  });

  interface Receipt {
    readonly status: 'success' | 'reverted';
    readonly blockNumber: bigint;
    readonly to?: Address;
    readonly logs: readonly ReturnType<typeof usedLog>[];
  }
  interface Chain {
    readonly chainId?: number;
    // Nonce state at the finalized block, and at the latest block when it differs
    readonly used?: boolean;
    readonly usedLatest?: boolean;
    readonly logs?: readonly Hash[];
    readonly receipts?: Readonly<Record<Hash, Receipt | Error>>;
    readonly inputs?: Readonly<Record<Hash, Hex>>;
  }

  // A chain finalized at block 1000, two seconds per block
  function chain(state: Chain) {
    const { getBlock } = fakeChain(FINAL, timeAt);
    const usedAt = (blockNumber?: bigint) =>
      blockNumber === undefined ? (state.usedLatest ?? state.used ?? false) : (state.used ?? false);
    const getLogs = vi.fn(async () =>
      (state.logs ?? []).map((transactionHash) => ({ transactionHash })),
    );
    const client = {
      getChainId: async () => state.chainId ?? 8453,
      getBlock,
      readContract: async (args: { functionName: string; blockNumber?: bigint }) =>
        args.functionName === 'nonceBitmap'
          ? // Permit2 nonce 7 is bit 7 of word 0
            usedAt(args.blockNumber)
            ? 1n << 7n
            : 1n << 6n
          : usedAt(args.blockNumber),
      getLogs,
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        const receipt = state.receipts?.[hash];
        if (receipt === undefined) throw new TransactionReceiptNotFoundError({ hash });
        if (receipt instanceof Error) throw receipt;
        return receipt;
      },
      getTransaction: async ({ hash }: { hash: Hash }) => ({ input: state.inputs?.[hash] ?? '0x' }),
    } as unknown as PublicClient;
    return { client, getLogs };
  }

  const eip3009 = (validBefore: bigint) => {
    const locator = parseEvmLocator(
      eip3009Locator('eip155:8453', ASSET, {
        from: BUYER,
        to: MERCHANT,
        value: '10000',
        validAfter: '0',
        validBefore: String(validBefore),
        nonce: NONCE,
      }),
    );
    if (locator === undefined) throw new Error('the locator did not parse');
    return locator;
  };
  const permit2 = (deadline: bigint) => {
    const locator = parseEvmLocator(
      permit2Locator('eip155:8453', {
        asset: ASSET,
        owner: BUYER,
        to: MERCHANT,
        amount: '10000',
        nonce: '7',
        deadline: String(deadline),
        validAfter: '0',
        proxy: PROXY,
      }),
    );
    if (locator === undefined) throw new Error('the locator did not parse');
    return locator;
  };
  // Created at block 400, so the search starts at genesis after the clock margin
  const attempt = (externalReference?: string): PaymentAttempt => ({
    ...ATTEMPT,
    createdAt: iso(timeAt(400n)),
    ...(externalReference !== undefined ? { externalReference } : {}),
  });
  const read = (state: Chain, locator: ReturnType<typeof eip3009>, ref?: string) =>
    readEvmEvidence({ client: chain(state).client, chainId: 8453, locator, attempt: attempt(ref) });

  const paid = (
    blockNumber: bigint,
    logs = [usedLog(BUYER, NONCE), transferLog(BUYER, MERCHANT, 10_000n)],
  ) => ({ status: 'success', blockNumber, logs }) as const;
  const finality = { finalizedBlock: '1000', finalizedAt: iso(timeAt(FINAL)) };

  it('reports a chain mismatch before reading any evidence', async () => {
    const { client, getLogs } = chain({ chainId: 1 });

    const result = await readEvmEvidence({
      client,
      chainId: 8453,
      locator: eip3009(timeAt(900n)),
      attempt: attempt(),
    });

    expect(result).toEqual({
      outcome: 'unknown',
      reason: 'chain_mismatch',
      evidence: { chainId: 1, expectedChainId: 8453 },
    });
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('settles from the recorded transaction when its receipt is final', async () => {
    const result = await read(
      { used: true, receipts: { [TX]: paid(990n) } },
      eip3009(timeAt(900n)),
      TX,
    );

    expect(result).toEqual({
      outcome: 'settled',
      reason: 'transfer_final',
      externalReference: TX,
      evidence: { transactionHash: TX, blockNumber: '990', ...finality },
    });
  });

  it('waits on a matching transfer in a block after the finalized one', async () => {
    const result = await read(
      { used: true, receipts: { [TX]: paid(1_001n) } },
      eip3009(timeAt(900n)),
      TX,
    );

    expect(result).toEqual({
      outcome: 'unknown',
      reason: 'not_final',
      evidence: { transactionHash: TX, blockNumber: '1001', ...finality },
    });
  });

  it('does not settle from a reverted recorded transaction', async () => {
    const result = await read(
      { used: false, receipts: { [TX]: { ...paid(990n), status: 'reverted' } } },
      eip3009(timeAt(FINAL)),
      TX,
    );

    expect(result).toMatchObject({ outcome: 'not-settled', reason: 'expired_unused' });
  });

  it('answers not settled once the finalized block reaches validBefore with the nonce unused', async () => {
    const result = await read({ used: false }, eip3009(timeAt(FINAL)));

    expect(result).toEqual({
      outcome: 'not-settled',
      reason: 'expired_unused',
      evidence: { nonceUsed: false, ...finality },
    });
  });

  it('waits one second before validBefore, naming the expiry as the retry time', async () => {
    const validBefore = timeAt(FINAL) + 1n;

    const result = await read({ used: false }, eip3009(validBefore));

    expect(result).toEqual({
      outcome: 'unknown',
      reason: 'not_expired',
      evidence: finality,
      retryAfter: iso(validBefore),
    });
  });

  it('waits when the nonce is used only after the finalized block, before expiry', async () => {
    const result = await read({ used: false, usedLatest: true }, eip3009(timeAt(FINAL) + 1n));

    expect(result).toEqual({ outcome: 'unknown', reason: 'not_final', evidence: finality });
  });

  it('settles from a transfer the log search finds', async () => {
    const result = await read(
      { used: true, logs: [TX], receipts: { [TX]: paid(500n) } },
      eip3009(timeAt(900n)),
    );

    expect(result).toMatchObject({ outcome: 'settled', externalReference: TX });
  });

  it.each([
    ['pays another recipient', [usedLog(BUYER, NONCE), transferLog(BUYER, BUYER, 10_000n)]],
    ['pays another amount', [usedLog(BUYER, NONCE), transferLog(BUYER, MERCHANT, 9_999n)]],
    ['transfers without using the nonce', [transferLog(BUYER, MERCHANT, 10_000n)]],
    [
      'uses another nonce',
      [usedLog(BUYER, `0x${'ac'.repeat(32)}`), transferLog(BUYER, MERCHANT, 10_000n)],
    ],
    [
      'emits the events from another contract',
      [usedLog(BUYER, NONCE, MERCHANT), transferLog(BUYER, MERCHANT, 10_000n, MERCHANT)],
    ],
  ])('does not settle from a transaction that %s', async (_label, logs) => {
    const result = await read(
      { used: true, logs: [TX], receipts: { [TX]: paid(500n, logs) } },
      eip3009(timeAt(900n)),
    );

    expect(result).toMatchObject({ outcome: 'unknown', reason: 'used_without_record' });
  });

  it('skips a candidate whose receipt the RPC cannot find', async () => {
    const result = await read(
      { used: true, logs: [OTHER, TX], receipts: { [TX]: paid(500n) } },
      eip3009(timeAt(900n)),
    );

    expect(result).toMatchObject({ outcome: 'settled', externalReference: TX });
  });

  it('fails the read on any other receipt error', async () => {
    await expect(
      read(
        { used: true, logs: [TX], receipts: { [TX]: new Error('rpc down') } },
        eip3009(timeAt(900n)),
      ),
    ).rejects.toThrow('rpc down');
  });

  describe('Permit2', () => {
    const permit = { permitted: { token: getAddress(ASSET), amount: 10_000n }, deadline: 9n };
    const witness = { to: getAddress(MERCHANT), validAfter: 0n };
    const signature = `0x${'11'.repeat(65)}` as const;
    const settleCall = (nonce: bigint) =>
      encodeFunctionData({
        abi: x402ExactPermit2ProxyABI,
        functionName: 'settle',
        args: [{ ...permit, nonce }, getAddress(BUYER), witness, signature],
      });
    const proxied = (to: Address = PROXY) =>
      ({
        status: 'success',
        blockNumber: 500n,
        to,
        logs: [transferLog(BUYER, MERCHANT, 10_000n)],
      }) as const;
    const readPermit2 = (state: Chain, deadline = timeAt(900n)) =>
      readEvmEvidence({
        client: chain(state).client,
        chainId: 8453,
        locator: permit2(deadline),
        attempt: attempt(),
      });

    it('settles from a proxy call that names the nonce', async () => {
      const result = await readPermit2({
        used: true,
        logs: [TX],
        receipts: { [TX]: proxied() },
        inputs: { [TX]: settleCall(7n) },
      });

      expect(result).toMatchObject({ outcome: 'settled', externalReference: TX });
    });

    it.each([
      ['names another nonce', proxied(), settleCall(8n)],
      ['was not sent to the proxy', proxied(getAddress(MERCHANT)), settleCall(7n)],
    ])('does not settle from a transfer whose transaction %s', async (_label, receipt, input) => {
      const result = await readPermit2({
        used: true,
        logs: [TX],
        receipts: { [TX]: receipt },
        inputs: { [TX]: input },
      });

      expect(result).toMatchObject({ outcome: 'unknown', reason: 'used_without_record' });
    });

    it('waits while the finalized block is at the deadline, which Permit2 still accepts', async () => {
      const result = await readPermit2({ used: false }, timeAt(FINAL));

      expect(result).toMatchObject({ outcome: 'unknown', reason: 'not_expired' });
    });

    it('answers not settled one second after the deadline with the nonce unused', async () => {
      const result = await readPermit2({ used: false }, timeAt(FINAL) - 1n);

      expect(result).toMatchObject({ outcome: 'not-settled', reason: 'expired_unused' });
    });
  });
});
