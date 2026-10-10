/**
 * Solana offers through a remote facilitator, mocked at the SDK's HTTP client:
 * the fee payer from `/supported`, verification, settlement classification and
 * the readiness checks against a Solana RPC
 */
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import type { PaymentRequirements, SupportedResponse } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Clock,
  CommerceResource,
  PaymentContext,
  PaymentRequirement,
} from '../../../src/core';
import { isCommerceError } from '../../../src/core';
import { createPaymentProof } from '../../../src/payments/x402/client';
import {
  createX402PaymentProvider,
  type X402MultiOfferProviderOptions,
} from '../../../src/payments/x402/provider';
import { svmReplayKey } from '../../../src/payments/x402/svm';
import { mintAccount } from '../../fixtures/x402/solana-validator';
import { buildSvmPayment } from '../../fixtures/x402/svm-transaction';

const verifyMock = vi.fn();
const settleMock = vi.fn();
const getSupportedMock = vi.fn();

vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return verifyMock(...args);
    }
    settle(...args: unknown[]) {
      return settleMock(...args);
    }
    getSupported() {
      return getSupportedMock();
    }
  },
}));

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const RPC_URL = 'https://solana-devnet.example';
// A well-formed transaction signature: 64 bytes in base58
const SIGNATURE =
  '61HQAvrUL3kcNhYW9nYLGYvVbY7fREZaNvpvTyoMEpEHXcMS2i4pF8ThAGH8QNHHvhUMor8GEffUdHLSp4qQJd83';

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USD' },
  exposedVia: ['http'],
  paymentMethods: ['x402'],
};

const paymentContext = (): PaymentContext => ({
  requestId: 'req-1',
  resource: RESOURCE,
  amount: '0.01',
  currency: 'USD',
  requestedAt: new Date().toISOString(),
});

let buyer: KeyPairSigner;
let payTo: string;
let feePayer: string;

function supported(payer: string | undefined, signers: string[] = []): SupportedResponse {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: 'exact',
        network: DEVNET,
        ...(payer !== undefined ? { extra: { feePayer: payer } } : {}),
      },
    ],
    extensions: [],
    signers: { 'solana:*': signers },
  };
}

// A clock that only advance() moves, for the fee payer snapshot
let nowMs = 0;
const clock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString() as ReturnType<Clock['nowIso']>,
  monotonicMs: () => nowMs,
};

function makeProvider(overrides: Partial<X402MultiOfferProviderOptions> = {}) {
  return createX402PaymentProvider({
    offers: [{ network: DEVNET, rpcUrl: RPC_URL, asset: USDC, assetDecimals: 6, payTo }],
    facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
    clock,
    ...overrides,
  });
}

async function paidRequest(provider: ReturnType<typeof makeProvider>) {
  const requirement = await provider.createRequirement(paymentContext());
  const accepted = requirement.challenge.accepts[0] as Record<string, unknown>;
  const transaction = await buildSvmPayment({
    buyer,
    feePayer,
    mint: USDC,
    payTo,
    amount: 10_000n,
    decimals: 6,
  });
  const submission = {
    method: 'x402' as const,
    payload: Buffer.from(
      JSON.stringify({ x402Version: 2, accepted, payload: { transaction } }),
    ).toString('base64'),
  };
  return {
    requirement,
    transaction,
    context: { requestId: 'req-1', resource: RESOURCE, requirement, submission },
  };
}

beforeAll(async () => {
  buyer = await generateKeyPairSigner();
  payTo = (await generateKeyPairSigner()).address;
  feePayer = (await generateKeyPairSigner()).address;
});

beforeEach(() => {
  vi.resetAllMocks();
  nowMs = 0;
  getSupportedMock.mockResolvedValue(supported(feePayer, [feePayer]));
});

describe('a Solana offer', () => {
  it('carries the fee payer from /supported, as the SDK server scheme adds it', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const offered = requirement.challenge.accepts[0] as Record<string, unknown>;
    expect(offered).toMatchObject({ network: DEVNET, asset: USDC, payTo, amount: '10000' });
    expect(offered['extra']).toEqual({ feePayer });

    const kind = supported(feePayer).kinds[0] as SupportedResponse['kinds'][number];
    const sdk = await new ExactSvmScheme().enhancePaymentRequirements(
      { ...(offered as unknown as PaymentRequirements), extra: {} },
      kind,
      [],
    );
    expect(sdk.extra).toEqual(offered['extra']);
    expect(provider.descriptor.capabilities).toContain('exact-svm');
    expect(provider.descriptor.supportedSpec).toContain('family=solana');
  });

  it('keeps its fee payer across snapshots while the facilitator still signs with it', async () => {
    const provider = makeProvider();
    const other = (await generateKeyPairSigner()).address;
    const feePayerOf = async () =>
      (
        (await provider.createRequirement(paymentContext())).challenge.accepts[0] as {
          extra: { feePayer: string };
        }
      ).extra.feePayer;
    expect(await feePayerOf()).toBe(feePayer);

    nowMs += 61_000;
    getSupportedMock.mockResolvedValue(supported(other, [feePayer, other]));
    expect(await feePayerOf()).toBe(feePayer);

    nowMs += 61_000;
    getSupportedMock.mockResolvedValue(supported(other, [other]));
    expect(await feePayerOf()).toBe(other);
  });

  it('builds no challenge when the facilitator names no fee payer', async () => {
    getSupportedMock.mockResolvedValue(supported(undefined));
    await expect(makeProvider().createRequirement(paymentContext())).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it.each<[string, Partial<X402MultiOfferProviderOptions['offers'][number]>, RegExp]>([
    [
      'a payee that is not a Solana key',
      { payTo: '0x1111111111111111111111111111111111111111' },
      /payTo.*Solana/,
    ],
    ['an EVM transfer method', { assetTransferMethod: 'permit2' }, /EVM networks only/],
  ])('refuses %s at construction', (_label, change, message) => {
    expect(() =>
      makeProvider({
        offers: [
          { network: DEVNET, rpcUrl: RPC_URL, asset: USDC, assetDecimals: 6, payTo, ...change },
        ],
      }),
    ).toThrow(message);
  });

  it('refuses the in-process facilitator', () => {
    expect(() =>
      makeProvider({ facilitator: { mode: 'local', signerPrivateKey: `0x${'11'.repeat(32)}` } }),
    ).toThrow(/serves the local Anvil chain/);
  });
});

describe('an EVM offer beside a Solana offer', () => {
  const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const EVM_PAY_TO = '0x1111111111111111111111111111111111111111';
  const BUYER_KEY = `0x${'5d'.repeat(32)}` as const;

  it('selects the offer each proof pays, by family', async () => {
    const provider = makeProvider({
      offers: [
        {
          network: 'eip155:84532',
          rpcUrl: 'https://base-sepolia.example',
          asset: BASE_SEPOLIA_USDC,
          assetName: 'USDC',
          assetVersion: '2',
          assetDecimals: 6,
          payTo: EVM_PAY_TO,
        },
        { network: DEVNET, rpcUrl: RPC_URL, asset: USDC, assetDecimals: 6, payTo },
      ],
    });
    const requirement = await provider.createRequirement(paymentContext());
    const [evmOffer, svmOffer] = requirement.challenge.accepts as Record<string, unknown>[];
    expect(requirement.destination).toBeUndefined();

    const evmProof = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY,
      accepts: evmOffer ?? {},
    });
    const transaction = await buildSvmPayment({
      buyer,
      feePayer,
      mint: USDC,
      payTo,
      amount: 10_000n,
      decimals: 6,
    });
    const svmProof = Buffer.from(
      JSON.stringify({ x402Version: 2, accepted: svmOffer, payload: { transaction } }),
    ).toString('base64');

    const select = (payload: string) =>
      provider.selectRequirement?.({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload },
      });
    expect(await select(evmProof)).toMatchObject({
      destination: EVM_PAY_TO,
      network: 'eip155:84532',
      metadata: { 'x402.offer': 0 },
    });
    expect(await select(svmProof)).toMatchObject({
      destination: payTo,
      network: DEVNET,
      asset: USDC,
      metadata: { 'x402.offer': 1 },
    });
  });
});

describe('verify()', () => {
  it('passes the transaction on and keys the payment by its message', async () => {
    const provider = makeProvider();
    const { context, transaction } = await paidRequest(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true, payer: buyer.address });

    const result = await provider.verify(context);
    expect(result).toMatchObject({
      status: 'verified',
      payer: buyer.address,
      payee: payTo,
      amount: '0.01',
      network: DEVNET,
      asset: USDC,
      replayKey: (svmReplayKey({ transaction }, DEVNET) as { replayKey: string }).replayKey,
    });
    expect(verifyMock.mock.calls[0]?.[0]).toMatchObject({ payload: { transaction } });
  });

  it('reads Solana addresses with their case', async () => {
    const provider = makeProvider();
    const { context, requirement } = await paidRequest(provider);
    const decoded = JSON.parse(Buffer.from(context.submission.payload, 'base64').toString('utf8'));
    decoded.accepted.payTo = payTo.toLowerCase();
    const result = await provider.verify({
      ...context,
      requirement: requirement as PaymentRequirement,
      submission: {
        method: 'x402',
        payload: Buffer.from(JSON.stringify(decoded)).toString('base64'),
      },
    });
    expect(result.rejectionReason).toBe('invalid_payment_requirements');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  // These compare the gateway's own offer with the facilitator's fee payers, or
  // with the buyer's echo, which the gateway already matched
  it.each([
    'invalid_exact_svm_fee_payer_not_managed_by_facilitator',
    'invalid_exact_svm_payload_missing_fee_payer',
    'invalid_exact_svm_unsupported_scheme',
    'invalid_exact_svm_network_mismatch',
  ])('treats %s as no verdict', async (invalidReason) => {
    const provider = makeProvider();
    const { context } = await paidRequest(provider);
    verifyMock.mockResolvedValueOnce({ isValid: false, invalidReason });
    await expect(provider.verify(context)).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('refuses a transaction that does not decode before the facilitator sees it', async () => {
    const provider = makeProvider();
    const { context } = await paidRequest(provider);
    const decoded = JSON.parse(Buffer.from(context.submission.payload, 'base64').toString('utf8'));
    decoded.payload.transaction = Buffer.from('not a transaction').toString('base64');
    const result = await provider.verify({
      ...context,
      submission: {
        method: 'x402',
        payload: Buffer.from(JSON.stringify(decoded)).toString('base64'),
      },
    });
    expect(result.rejectionReason).toBe(
      'invalid_exact_svm_payload_transaction_could_not_be_decoded',
    );
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe('settle()', () => {
  async function settleWith(response: Record<string, unknown>) {
    const provider = makeProvider();
    const { context } = await paidRequest(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true, payer: buyer.address });
    const verification = await provider.verify(context);
    settleMock.mockResolvedValueOnce({ network: DEVNET, ...response });
    return provider.settle({ ...context, verification });
  }

  const unavailable = (err: unknown) =>
    isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE';

  it('settles with the transaction signature as the reference', async () => {
    await expect(settleWith({ success: true, transaction: SIGNATURE })).resolves.toMatchObject({
      status: 'settled',
      externalReference: SIGNATURE,
      network: DEVNET,
      metadata: { amountBaseUnits: '10000' },
    });
  });

  it('keeps the payer verify() established when the settlement names the fee payer', async () => {
    // The Solana scheme's settlement example calls `payer` the fee payer
    await expect(
      settleWith({ success: true, transaction: SIGNATURE, payer: feePayer }),
    ).resolves.toMatchObject({ status: 'settled', payer: buyer.address });
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'a success without a Solana signature',
      { success: true, transaction: `0x${'ab'.repeat(32)}` },
    ],
    [
      'a success on another network',
      { success: true, transaction: SIGNATURE, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
    ],
    [
      'the broadcast catch-all without a signature',
      { success: false, transaction: '', errorReason: 'invalid_exact_svm_transaction_failed' },
    ],
    [
      'a settlement already in flight for the same transaction',
      { success: false, transaction: '', errorReason: 'duplicate_settlement' },
    ],
    [
      'a confirmed transaction whose transfer is not yet visible',
      {
        success: false,
        transaction: SIGNATURE,
        errorReason: 'post_settlement_transfer_not_confirmed',
      },
    ],
    [
      'a broadcast that was not confirmed',
      { success: false, transaction: SIGNATURE, errorReason: 'settlement_pending' },
    ],
    [
      'an unconfirmed broadcast the facilitator could not record for a retry',
      {
        success: false,
        transaction: SIGNATURE,
        errorReason: 'invalid_exact_svm_transaction_failed',
        errorMessage: 'settlement_pending, but failed to persist for retry: store offline',
      },
    ],
  ])('leaves the outcome unknown for %s', async (_label, response) => {
    await expect(settleWith(response)).rejects.toSatisfy(unavailable);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'a transaction that failed on chain',
      {
        success: false,
        transaction: SIGNATURE,
        errorReason: 'invalid_exact_svm_transaction_failed',
      },
    ],
    [
      'a refusal before the broadcast',
      { success: false, transaction: '', errorReason: 'invalid_exact_svm_payload_amount_mismatch' },
    ],
  ])('records a rejection for %s', async (_label, response) => {
    await expect(settleWith(response)).resolves.toMatchObject({
      status: 'rejected',
      rejectionReason: response['errorReason'],
    });
  });
});

describe('health()', () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: rpc(method) }));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mintResult = (decimals: number) => {
    const account = mintAccount(USDC, decimals, 1_000_000n);
    return {
      context: { slot: 1 },
      value: {
        owner: account.owner,
        data: [Buffer.from(account.data ?? []).toString('base64'), 'base64'],
      },
    };
  };

  it('passes for the named cluster, a mint with the configured decimals and a fee payer', async () => {
    rpc.mockImplementation((method: string) =>
      method === 'getGenesisHash' ? DEVNET_GENESIS : mintResult(6),
    );
    const health = await makeProvider().health();
    expect(health.status).toBe('pass');
    expect(health.detail).toContain(`fee payer ${feePayer}`);
  });

  it.each<[string, () => void, RegExp]>([
    [
      'an RPC serving another cluster',
      () =>
        rpc.mockImplementation((m: string) =>
          m === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : mintResult(6),
        ),
      /serves solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp, expected solana:EtWT/,
    ],
    [
      'a mint with other decimals',
      () =>
        rpc.mockImplementation((m: string) =>
          m === 'getGenesisHash' ? DEVNET_GENESIS : mintResult(9),
        ),
      /has 9 decimals, configured 6/,
    ],
    [
      'no mint at the asset address',
      () =>
        rpc.mockImplementation((m: string) =>
          m === 'getGenesisHash' ? DEVNET_GENESIS : { context: { slot: 1 }, value: null },
        ),
      /No initialized token mint/,
    ],
    [
      'a facilitator without a fee payer',
      () => {
        rpc.mockImplementation((m: string) =>
          m === 'getGenesisHash' ? DEVNET_GENESIS : mintResult(6),
        );
        getSupportedMock.mockResolvedValue(supported(undefined));
      },
      /with a fee payer/,
    ],
  ])('fails for %s', async (_label, arrange, detail) => {
    arrange();
    const health = await makeProvider().health();
    expect(health.status).toBe('fail');
    expect(health.detail).toMatch(detail);
  });
});
