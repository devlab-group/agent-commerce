/**
 * Nano address checksums, payload inspection and send-block verification
 * against a mocked node RPC. Nothing here reaches a network.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCommerceError } from '../../../src/core';
import {
  isBurnAddress,
  isTransactionReference,
  normalizeAddress,
  sameAddress,
} from '../../../src/payments/x402/addresses';
import {
  checkNanoSend,
  createNanoRpc,
  inspectNanoPayload,
  type NanoRpc,
} from '../../../src/payments/x402/nano';
import {
  blake2b,
  nanoAddressFromPublicKey,
  nanoPublicKey,
} from '../../../src/payments/x402/nano-address';
import { findX402Network } from '../../../src/payments/x402/networks';

// The genesis account and its public key
const GENESIS = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const GENESIS_KEY = 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA';
const PAY_TO = nanoAddressFromPublicKey('11'.repeat(32));
const BUYER = nanoAddressFromPublicKey('22'.repeat(32));
const HASH = 'AB'.repeat(32);
const NETWORK = 'nano:mainnet';
const ONE_XNO = 10n ** 30n;

const nano = findX402Network(NETWORK);

function block(overrides: Record<string, unknown> = {}, contents: Record<string, unknown> = {}) {
  return {
    block_account: BUYER,
    amount: ONE_XNO.toString(),
    balance: '0',
    height: '2',
    confirmed: 'true',
    subtype: 'send',
    ...overrides,
    contents: {
      type: 'state',
      account: BUYER,
      link_as_account: PAY_TO,
      ...contents,
    },
  };
}

const rpcReturning =
  (value: unknown): NanoRpc =>
  async () =>
    value;

describe('the nano:mainnet network', () => {
  it('is built in, with the native coin at 30 decimals', () => {
    expect(nano).toMatchObject({
      family: 'nano',
      kind: 'mainnet',
      canonicalAsset: { symbol: 'XNO', address: 'XNO', decimals: 30 },
    });
  });
});

describe('Nano addresses', () => {
  it('computes BLAKE2b like node for the full digest, over one and several blocks', () => {
    for (const input of [Buffer.alloc(0), Buffer.from('abc'), Buffer.alloc(300, 7)]) {
      expect(Buffer.from(blake2b(input, 64)).toString('hex')).toBe(
        createHash('blake2b512').update(input).digest('hex'),
      );
    }
  });

  it('decodes and encodes the genesis account', () => {
    expect(nanoPublicKey(GENESIS)).toBe(GENESIS_KEY);
    expect(nanoAddressFromPublicKey(GENESIS_KEY)).toBe(GENESIS);
  });

  it('accepts the legacy xrb_ prefix as the same account', () => {
    const legacy = GENESIS.replace('nano_', 'xrb_');
    if (!nano) throw new Error('no profile');
    expect(normalizeAddress(nano, legacy)).toBe(GENESIS);
    expect(sameAddress(nano, legacy, GENESIS)).toBe(true);
    expect(sameAddress(nano, PAY_TO, GENESIS)).toBe(false);
  });

  it.each([
    ['a bad checksum', `${GENESIS.slice(0, -1)}1`],
    ['uppercase', GENESIS.toUpperCase()],
    ['no prefix', GENESIS.slice('nano_'.length)],
    ['a short body', GENESIS.slice(0, -2)],
    ['a key above 256 bits', `nano_4${GENESIS.slice(6)}`],
    ['a NEAR account', 'merchant.near'],
  ])('refuses %s', (_label, value) => {
    if (!nano) throw new Error('no profile');
    expect(normalizeAddress(nano, value)).toBeUndefined();
  });

  it('knows the burn address and the block hash form', () => {
    if (!nano) throw new Error('no profile');
    expect(isBurnAddress(nano, nanoAddressFromPublicKey('00'.repeat(32)))).toBe(true);
    expect(isBurnAddress(nano, PAY_TO)).toBe(false);
    expect(isTransactionReference(nano, HASH)).toBe(true);
    expect(isTransactionReference(nano, HASH.toLowerCase())).toBe(false);
  });
});

describe('inspectNanoPayload', () => {
  it('takes the block hash, in either case, as one replay key', () => {
    const upper = inspectNanoPayload({ blockHash: HASH }, NETWORK);
    const lower = inspectNanoPayload({ blockHash: HASH.toLowerCase() }, NETWORK);
    expect(upper).toMatchObject({ blockHash: HASH });
    expect(typeof upper === 'object' && typeof lower === 'object' && upper.replayKey).toBe(
      typeof lower === 'object' && lower.replayKey,
    );
  });

  it.each([
    ['no payload', undefined],
    ['no hash', {}],
    ['a short hash', { blockHash: 'AB'.repeat(31) }],
    ['a non-hex hash', { blockHash: 'ZZ'.repeat(32) }],
    ['a numeric hash', { blockHash: 123 }],
  ])('refuses %s', (_label, payload) => {
    expect(inspectNanoPayload(payload, NETWORK)).toBe('invalid_exact_nano_payload_block_hash');
  });
});

describe('checkNanoSend', () => {
  const terms = { blockHash: HASH, payTo: PAY_TO, amount: ONE_XNO };

  it('asks the node for the block as JSON and returns the sender and amount', async () => {
    const rpc = vi.fn<NanoRpc>().mockResolvedValue(block());
    await expect(checkNanoSend(rpc, terms)).resolves.toEqual({ payer: BUYER, amount: ONE_XNO });
    expect(rpc).toHaveBeenCalledWith({ action: 'block_info', json_block: 'true', hash: HASH });
  });

  it('accepts more than the offered amount, and a legacy xrb_ recipient', async () => {
    const more = block(
      { amount: (ONE_XNO + 1n).toString() },
      { link_as_account: PAY_TO.replace('nano_', 'xrb_') },
    );
    await expect(checkNanoSend(rpcReturning(more), terms)).resolves.toMatchObject({
      amount: ONE_XNO + 1n,
    });
  });

  it.each<[string, unknown, string]>([
    ['less than the offer', block({ amount: (ONE_XNO - 1n).toString() }), 'amount_insufficient'],
    ['another recipient', block({}, { link_as_account: BUYER }), 'recipient_mismatch'],
    ['an unconfirmed block', block({ confirmed: 'false' }), 'block_unconfirmed'],
    ['a receive block', block({ subtype: 'receive' }), 'block_not_send'],
    ['a legacy block', block({}, { type: 'send' }), 'block_not_send'],
    ['an unknown block', { error: 'Block not found' }, 'block_not_found'],
  ])('refuses %s', async (_label, response, reason) => {
    await expect(checkNanoSend(rpcReturning(response), terms)).resolves.toBe(
      `invalid_exact_nano_${reason}`,
    );
  });

  it.each<[string, NanoRpc]>([
    [
      'a node that is down',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['a node error', rpcReturning({ error: 'Internal server error' })],
    ['a body without a block', rpcReturning({ amount: 'lots' })],
    ['no object', rpcReturning('nope')],
  ])('throws a retryable error for %s, never a verdict', async (_label, rpc) => {
    const err = await checkNanoSend(rpc, terms).catch((e: unknown) => e);
    expect(isCommerceError(err) && err.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });
});

describe('createNanoRpc', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the request as JSON to the node and returns its body', async () => {
    const fetchMock = vi.fn(async () => new Response('{"network":"live"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createNanoRpc('https://node.example', 1000)({ action: 'version' }),
    ).resolves.toEqual({ network: 'live' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://node.example',
      expect.objectContaining({ method: 'POST', body: '{"action":"version"}' }),
    );
  });

  it('treats an HTTP error as an unavailable node', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    );
    const err = await createNanoRpc(
      'https://node.example',
      1000,
    )({ action: 'version' }).catch((e: unknown) => e);
    expect(isCommerceError(err) && err.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });
});
