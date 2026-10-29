// Reconciliation input checks, log-query ranges and proxy calldata
import { x402ExactPermit2ProxyABI } from '@x402/evm';
import { encodeFunctionData, getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import type { PaymentAttempt, PaymentProvider } from '../../../src/core';
import { eip3009Locator, permit2Locator } from '../../../src/payments/x402/locator';
import { createX402PaymentProvider } from '../../../src/payments/x402/provider';
import { logRanges, proxyCall } from '../../../src/payments/x402/reconcile/evm';

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

  it('answers unsupported_family for a Solana locator', async () => {
    expect(
      await reconcile({
        v: 1,
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        messageHash: 'x',
      }),
    ).toEqual({ outcome: 'unknown', reason: 'unsupported_family' });
  });

  it.each([
    ['EIP-3009', EIP3009],
    ['Permit2', PERMIT2],
  ])(
    'reads a %s locator as verify writes it, then needs its network configured',
    async (_label, locator) => {
      expect(await reconcile(locator)).toEqual({
        outcome: 'unknown',
        reason: 'network_not_configured',
        evidence: { network: 'eip155:8453' },
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
