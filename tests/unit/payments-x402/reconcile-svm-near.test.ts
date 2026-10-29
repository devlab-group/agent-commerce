// Scripted Solana and NEAR RPC tests for history paging, expiry boundaries,
// malformed responses and node errors
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CommerceError, isCommerceError, type PaymentAttempt } from '../../../src/core';
import { jsonRpc } from '../../../src/payments/x402/json-rpc';
import { parseNearLocator, readNearEvidence } from '../../../src/payments/x402/reconcile/near';
import { parseSvmLocator, readSvmEvidence } from '../../../src/payments/x402/reconcile/svm';

const ATTEMPT: PaymentAttempt = {
  id: 'pa_1',
  requestId: 'req_1',
  resourceId: 'demo.report',
  provider: 'x402',
  replayKey: 'replay_1',
  status: 'settlement-uncertain',
  amount: '1.00',
  currency: 'USDC',
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
};
const CREATED_AT = Date.parse(ATTEMPT.createdAt) / 1000;

type Answer = (params: unknown) => unknown;

// Serve scripted answers and record calls; `nodeError` results throw a
// CommerceError with the node's error body, as jsonRpc does
function scripted(answers: Record<string, Answer>) {
  const calls: { method: string; params: unknown }[] = [];
  const rpc = async (method: string, params: unknown) => {
    calls.push({ method, params });
    const answer = answers[method];
    if (answer === undefined) throw new Error(`unexpected RPC ${method}`);
    const result = answer(params);
    if (result instanceof NodeError) {
      throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', `RPC ${method} failed`, {
        details: { rpcError: result.body },
      });
    }
    return result;
  };
  return { rpc, calls, methods: () => calls.map((call) => call.method) };
}

class NodeError {
  constructor(readonly body: unknown) {}
}
const nodeError = (name: string) =>
  new NodeError({ name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000 });

describe('jsonRpc', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function serve(body: unknown): Promise<string> {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('returns the result', async () => {
    const url = await serve({ jsonrpc: '2.0', id: 1, result: { chain_id: 'testnet' } });
    expect(await jsonRpc(url, 'status', [], 5_000)).toEqual({ chain_id: 'testnet' });
  });

  it("throws PAYMENT_PROVIDER_UNAVAILABLE carrying the node's error object", async () => {
    const error = { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' }, code: -32000 };
    const url = await serve({ jsonrpc: '2.0', id: 1, error });

    const thrown = await jsonRpc(url, 'tx', {}, 5_000).catch((err: unknown) => err);
    expect(isCommerceError(thrown) && thrown.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(isCommerceError(thrown) && thrown.details).toEqual({ rpcError: error });
  });
});

describe('Solana evidence', () => {
  const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  const HASH = `${'Q'.repeat(43)}=`;
  const PAYER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const ID = (n: number) => `${'5'.repeat(80)}${String(n).padStart(8, 'A')}`.replace(/0/g, 'z');
  const LOCATOR = {
    v: 1,
    network: NETWORK,
    messageHash: HASH,
    recentBlockhash: '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn',
    payer: PAYER,
  };
  // Treat `landed` as transaction bytes with the locator's message hash
  const messageHashOf = (wire: string) => (wire === 'landed' ? HASH : `${'R'.repeat(43)}=`);
  const transaction = (wire: string, err: unknown = null) => ({
    slot: 77,
    meta: { err },
    transaction: [wire, 'base64'],
  });

  function read(
    answers: Record<string, Answer>,
    overrides: Record<string, unknown> = {},
    attempt = {},
  ) {
    const node = scripted({ getGenesisHash: () => GENESIS, ...answers });
    const locator = parseSvmLocator({ ...LOCATOR, ...overrides });
    if (locator === undefined) throw new Error('fixture locator does not parse');
    const result = readSvmEvidence({
      rpc: node.rpc,
      network: NETWORK,
      locator,
      attempt: { ...ATTEMPT, ...attempt },
      messageHashOf,
    });
    return { result, node };
  }
  const valid = (value: unknown) => () => ({ context: { slot: 1 }, value });

  it('answers chain_mismatch before any other read', async () => {
    const { result, node } = read({ getGenesisHash: () => '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' });
    expect(await result).toEqual({
      outcome: 'unknown',
      reason: 'chain_mismatch',
      evidence: { network: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', expectedNetwork: NETWORK },
    });
    expect(node.methods()).toEqual(['getGenesisHash']);
  });

  it.each([
    ['a failed transaction', transaction('landed', { InstructionError: [0, 'Custom'] })],
    ['another message', transaction('other')],
    ['no transaction at finality', null],
  ])('does not take %s under the reference as settlement', async (_label, landed) => {
    const { result } = read(
      { getTransaction: () => landed, isBlockhashValid: valid(true) },
      { payer: undefined },
      { externalReference: ID(1) },
    );
    expect(await result).toEqual({
      outcome: 'unknown',
      reason: 'not_expired',
      evidence: { payerSearched: false },
    });
  });

  it('reads the reference at finalized commitment', async () => {
    const { result, node } = read(
      { getTransaction: () => transaction('landed') },
      {},
      { externalReference: ID(1) },
    );
    expect(await result).toEqual({
      outcome: 'settled',
      reason: 'transfer_final',
      externalReference: ID(1),
      evidence: { transactionId: ID(1), slot: '77' },
    });
    expect(node.calls[1]).toEqual({
      method: 'getTransaction',
      params: [
        ID(1),
        { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      ],
    });
  });

  it('does not look up a reference that is not a Solana signature', async () => {
    const { result, node } = read(
      { isBlockhashValid: valid(true) },
      { payer: undefined },
      { externalReference: '0xabc' },
    );
    await result;
    expect(node.methods()).toEqual(['getGenesisHash', 'isBlockhashValid']);
  });

  it("pages the payer's history and checks only successful entries inside the window", async () => {
    const page1 = [
      { signature: ID(1), err: null, blockTime: CREATED_AT + 901 },
      { signature: ID(2), err: { InstructionError: [0, 'Custom'] }, blockTime: CREATED_AT },
      ...Array.from({ length: 997 }, (_, i) => ({
        signature: ID(10 + i),
        err: null,
        blockTime: CREATED_AT + 900,
      })),
      { signature: ID(3), err: null, blockTime: null },
    ];
    const page2 = [
      { signature: ID(4), err: null, blockTime: CREATED_AT - 900 },
      { signature: ID(5), err: null, blockTime: CREATED_AT - 901 },
      { signature: ID(6), err: null, blockTime: CREATED_AT },
    ];
    const pages = [page1, page2];
    const looked: string[] = [];
    const { result, node } = read({
      getSignaturesForAddress: () => pages.shift(),
      getTransaction: (params) => {
        const [id] = params as [string];
        looked.push(id);
        return transaction('other');
      },
      isBlockhashValid: valid(false),
    });

    expect(await result).toEqual({
      outcome: 'unknown',
      reason: 'blockhash_expired',
      evidence: { payerSearched: true },
    });
    // Skip transaction reads for failed entries and entries outside the time window
    expect(looked).toEqual([...Array.from({ length: 997 }, (_, i) => ID(10 + i)), ID(3), ID(4)]);
    const searches = node.calls.filter((call) => call.method === 'getSignaturesForAddress');
    expect(searches.map((call) => call.params)).toEqual([
      [PAYER, { commitment: 'finalized', limit: 1000 }],
      [PAYER, { commitment: 'finalized', limit: 1000, before: ID(3) }],
    ]);
  });

  it('settles from the matching history entry', async () => {
    const { result } = read({
      getSignaturesForAddress: () => [{ signature: ID(1), err: null, blockTime: CREATED_AT }],
      getTransaction: () => transaction('landed'),
    });
    expect(await result).toEqual({
      outcome: 'settled',
      reason: 'transfer_final',
      externalReference: ID(1),
      evidence: { transactionId: ID(1), slot: '77' },
    });
  });

  it('stops at an empty history', async () => {
    const { result, node } = read({
      getSignaturesForAddress: () => [],
      isBlockhashValid: valid(true),
    });
    expect(await result).toMatchObject({ reason: 'not_expired' });
    expect(node.methods().filter((m) => m === 'getSignaturesForAddress')).toHaveLength(1);
  });

  it('answers history_too_long after five full pages inside the window', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({
      signature: ID(i),
      err: { InstructionError: [0, 'Custom'] },
      blockTime: CREATED_AT,
    }));
    const { result, node } = read({ getSignaturesForAddress: () => full });
    expect(await result).toEqual({
      outcome: 'unknown',
      reason: 'history_too_long',
      evidence: { payer: PAYER },
    });
    expect(node.methods().filter((m) => m === 'getSignaturesForAddress')).toHaveLength(5);
  });

  it.each([
    ['a history that is not a list', { getSignaturesForAddress: () => ({}) }],
    [
      'a blockhash answer without a boolean',
      { getSignaturesForAddress: () => [], isBlockhashValid: valid('yes') },
    ],
  ])('throws PAYMENT_PROVIDER_UNAVAILABLE for %s', async (_label, answers) => {
    const thrown = await read(answers).result.catch((err: unknown) => err);
    expect(isCommerceError(thrown) && thrown.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });

  it('reads blockhash validity at confirmed commitment', async () => {
    const { result, node } = read({ isBlockhashValid: valid(true) }, { payer: undefined });
    await result;
    expect(node.calls.at(-1)).toEqual({
      method: 'isBlockhashValid',
      params: [LOCATOR.recentBlockhash, { commitment: 'confirmed' }],
    });
  });
});

describe('NEAR evidence', () => {
  const HASH = 'Ez28iCGrSWAo8Dc7kgVxPjpYvLUz8wXwTFWAxPn4ZbFK';
  const TOKEN = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  const PUBLIC_KEY = 'ed25519:47unvknMVQJ87USpHGn1uxXMQXZKEi9Wjnzvw18FAph6';
  const LOCATOR = {
    v: 1,
    network: 'near:mainnet',
    senderId: 'buyer.near',
    publicKey: PUBLIC_KEY,
    nonce: '4000001',
    maxBlockHeight: '42',
    asset: TOKEN,
    receiver: 'merchant.near',
    amount: '1000000',
    relayers: ['first.near', 'second.near'],
  };
  const args = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64');

  interface Changes {
    readonly status?: string;
    readonly delegate?: Record<string, unknown>;
    readonly actions?: unknown[];
    readonly method?: string;
    readonly transfer?: Record<string, unknown> | string;
    readonly transferStatus?: unknown;
    readonly token?: string;
    readonly from?: string;
  }

  // Model a settled delegate's relayer transaction, with optional `changes`
  function outcome(changes: Changes = {}) {
    const transfer = changes.transfer ?? { receiver_id: 'merchant.near', amount: '1000000' };
    return {
      final_execution_status: changes.status ?? 'FINAL',
      transaction: {
        signer_id: 'first.near',
        receiver_id: 'buyer.near',
        actions: changes.actions ?? [
          {
            Delegate: {
              delegate_action: {
                sender_id: 'buyer.near',
                receiver_id: TOKEN,
                public_key: PUBLIC_KEY,
                nonce: 4000001,
                max_block_height: 42,
                ...changes.delegate,
              },
            },
          },
        ],
      },
      receipts: [
        { receipt_id: 'r1', receiver_id: 'buyer.near', predecessor_id: 'first.near', receipt: {} },
        {
          receipt_id: 'r2',
          receiver_id: changes.token ?? TOKEN,
          predecessor_id: changes.from ?? 'buyer.near',
          receipt: {
            Action: {
              actions: [
                {
                  FunctionCall: {
                    method_name: changes.method ?? 'ft_transfer',
                    args: typeof transfer === 'string' ? transfer : args(transfer),
                  },
                },
              ],
            },
          },
        },
      ],
      receipts_outcome: [
        { id: 'r1', outcome: { status: { SuccessValue: '' } } },
        { id: 'r2', outcome: { status: changes.transferStatus ?? { SuccessValue: '' } } },
      ],
    };
  }

  function read(
    answers: Record<string, Answer>,
    overrides: Record<string, unknown> = {},
    attempt: Partial<PaymentAttempt> = { externalReference: HASH },
  ) {
    const node = scripted({
      status: () => ({ chain_id: 'mainnet' }),
      block: () => ({ header: { height: 40 } }),
      query: () => ({ nonce: 4000000, block_height: 40 }),
      ...answers,
    });
    const locator = parseNearLocator({ ...LOCATOR, ...overrides });
    if (locator === undefined) throw new Error('fixture locator does not parse');
    const result = readNearEvidence({
      rpc: node.rpc,
      network: 'near:mainnet',
      locator,
      attempt: { ...ATTEMPT, ...attempt },
    });
    return { result, node };
  }
  const notExpired = {
    outcome: 'unknown',
    reason: 'not_expired',
    evidence: { maxBlockHeight: '42', keyNonce: '4000000', finalBlock: '40' },
  };

  it('answers chain_mismatch before any other read', async () => {
    const { result, node } = read({ status: () => ({ chain_id: 'testnet' }) });
    expect(await result).toEqual({
      outcome: 'unknown',
      reason: 'chain_mismatch',
      evidence: { chainId: 'testnet', expectedChainId: 'mainnet' },
    });
    expect(node.methods()).toEqual(['status']);
  });

  it('asks each relayer in turn and settles with the one that signed', async () => {
    const { result, node } = read({
      EXPERIMENTAL_tx_status: (params) =>
        (params as { sender_account_id: string }).sender_account_id === 'first.near'
          ? nodeError('UNKNOWN_TRANSACTION')
          : outcome(),
    });
    expect(await result).toEqual({
      outcome: 'settled',
      reason: 'transfer_final',
      externalReference: HASH,
      evidence: { transactionHash: HASH, relayer: 'second.near' },
    });
    expect(node.calls.slice(1).map((call) => call.params)).toEqual([
      { tx_hash: HASH, sender_account_id: 'first.near', wait_until: 'NONE' },
      { tx_hash: HASH, sender_account_id: 'second.near', wait_until: 'NONE' },
    ]);
  });

  it('answers not_final for a transaction short of FINAL status', async () => {
    const { result } = read({
      EXPERIMENTAL_tx_status: () => outcome({ status: 'EXECUTED_OPTIMISTIC' }),
    });
    expect(await result).toEqual({
      outcome: 'unknown',
      reason: 'not_final',
      evidence: { transactionHash: HASH },
    });
  });

  it.each<[string, Changes]>([
    ['another delegate nonce', { delegate: { nonce: 4000002 } }],
    ['another access key', { delegate: { public_key: 'ed25519:other' } }],
    ['another sender', { delegate: { sender_id: 'other.near' } }],
    ['no delegate action', { actions: [{ Transfer: { deposit: '1' } }] }],
    ['a failed ft_transfer', { transferStatus: { Failure: {} } }],
    ['another receiver', { transfer: { receiver_id: 'thief.near', amount: '1000000' } }],
    ['another amount', { transfer: { receiver_id: 'merchant.near', amount: '1' } }],
    ['undecodable arguments', { transfer: '%%%' }],
    ['another method', { method: 'ft_transfer_call' }],
    ['another token', { token: 'usdt.near' }],
    ['a transfer from another account', { from: 'other.near' }],
  ])('reads the key state when the transaction carries %s', async (_label, change) => {
    const { result, node } = read({ EXPERIMENTAL_tx_status: () => outcome(change) });
    expect(await result).toEqual(notExpired);
    // A final response ends the relayer search, even when the delegate does not match
    expect(node.methods()).toEqual(['status', 'EXPERIMENTAL_tx_status', 'block', 'query']);
  });

  it('reads the access key at the final block it compares with maxBlockHeight', async () => {
    const { result, node } = read({}, {}, {});
    expect(await result).toEqual(notExpired);
    expect(node.calls.slice(1)).toEqual([
      { method: 'block', params: { finality: 'final' } },
      {
        method: 'query',
        params: {
          request_type: 'view_access_key',
          block_id: 40,
          account_id: 'buyer.near',
          public_key: PUBLIC_KEY,
        },
      },
    ]);
  });

  it.each([
    ['no reference', {}, LOCATOR.relayers],
    ['a reference that is not a NEAR hash', { externalReference: '0xabc' }, LOCATOR.relayers],
    ['no relayers', { externalReference: HASH }, []],
  ])('skips the transaction lookup with %s', async (_label, attempt, relayers) => {
    const { result, node } = read({}, { relayers }, attempt);
    expect(await result).toEqual(notExpired);
    expect(node.methods()).toEqual(['status', 'block', 'query']);
  });

  it.each<[string, number, number, Record<string, unknown>]>([
    [
      'unused at maxBlockHeight',
      42,
      4000000,
      { ...notExpired, evidence: { maxBlockHeight: '42', keyNonce: '4000000', finalBlock: '42' } },
    ],
    [
      'unused past maxBlockHeight',
      43,
      4000000,
      {
        outcome: 'not-settled',
        reason: 'expired_unused',
        evidence: { keyNonce: '4000000', finalBlock: '43' },
      },
    ],
    [
      'used at the delegate nonce',
      43,
      4000001,
      {
        outcome: 'unknown',
        reason: 'used_without_record',
        evidence: { keyNonce: '4000001', finalBlock: '43' },
      },
    ],
    [
      'passed by a later nonce',
      30,
      4000005,
      {
        outcome: 'unknown',
        reason: 'used_without_record',
        evidence: { keyNonce: '4000005', finalBlock: '30' },
      },
    ],
  ])('answers for a key %s', async (_label, height, keyNonce, expected) => {
    const { result } = read(
      { block: () => ({ header: { height } }), query: () => ({ nonce: keyNonce }) },
      {},
      {},
    );
    expect(await result).toEqual(expected);
  });

  it.each([
    ['a JSON-RPC error', () => nodeError('UNKNOWN_ACCESS_KEY')],
    [
      'an error in the result',
      () => ({ error: 'access key ed25519:x does not exist while viewing' }),
    ],
  ])(
    'answers access_key_missing when the node reports a deleted key as %s',
    async (_label, query) => {
      const { result } = read({ query }, {}, {});
      expect(await result).toEqual({
        outcome: 'unknown',
        reason: 'access_key_missing',
        evidence: { finalBlock: '40' },
      });
    },
  );

  it.each([
    [
      'another transaction lookup error',
      { EXPERIMENTAL_tx_status: () => nodeError('TIMEOUT_ERROR') },
      { externalReference: HASH },
    ],
    ['another access key error', { query: () => nodeError('UNAVAILABLE_SHARD') }, {}],
    ['a block without a height', { block: () => ({ header: {} }) }, {}],
    ['a key without a nonce', { query: () => ({ permission: 'FullAccess' }) }, {}],
  ])('rejects on %s', async (_label, answers, attempt) => {
    const thrown = await read(answers, {}, attempt).result.catch((err: unknown) => err);
    expect(isCommerceError(thrown) && thrown.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });
});
