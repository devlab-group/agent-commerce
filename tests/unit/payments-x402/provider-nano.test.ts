/**
 * Tests Nano offers through the x402 provider: the challenge, verification and
 * settlement of a published send block, replay identity and readiness. The
 * node RPC is a stubbed `fetch`, and the facilitator is mocked to prove it is
 * never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceResource, PaymentContext, PaymentResult } from '../../../src/core';
import { isCommerceError } from '../../../src/core';
import { nanoAddressFromPublicKey } from '../../../src/payments/x402/nano-address';
import {
  createX402PaymentProvider,
  type X402MultiOfferProviderOptions,
} from '../../../src/payments/x402/provider';
import { computeNanoReplayKey } from '../../../src/payments/x402/replay-key';

const facilitatorCalls = vi.fn();

vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitatorCalls('verify', ...args);
    }
    settle(...args: unknown[]) {
      return facilitatorCalls('settle', ...args);
    }
    getSupported() {
      return facilitatorCalls('supported');
    }
  },
}));

const NETWORK = 'nano:mainnet';
const RPC_URL = 'https://nano-node.example';
const PAY_TO = nanoAddressFromPublicKey('11'.repeat(32));
const BUYER = nanoAddressFromPublicKey('22'.repeat(32));
const HASH = 'AB'.repeat(32);
// 0.001 XNO
const PRICE_RAW = 10n ** 27n;

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '0.001', currency: 'XNO' },
  exposedVia: ['http'],
  paymentMethods: ['x402'],
};

const paymentContext = (currency = 'XNO'): PaymentContext => ({
  requestId: 'req-1',
  resource: RESOURCE,
  amount: '0.001',
  currency,
  requestedAt: new Date().toISOString(),
});

const sendBlock = (overrides: Record<string, unknown> = {}, link = PAY_TO) => ({
  block_account: BUYER,
  amount: PRICE_RAW.toString(),
  confirmed: 'true',
  subtype: 'send',
  ...overrides,
  contents: { type: 'state', account: BUYER, link_as_account: link },
});

const rpc = vi.fn<(body: Record<string, unknown>) => unknown>();

function makeProvider(overrides: Partial<X402MultiOfferProviderOptions> = {}) {
  return createX402PaymentProvider({
    offers: [{ network: NETWORK, rpcUrl: RPC_URL, asset: 'XNO', assetDecimals: 30, payTo: PAY_TO }],
    facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
    allowMainnet: true,
    allowUnauthenticatedFacilitator: true,
    ...overrides,
  });
}

async function paidRequest(
  provider: ReturnType<typeof makeProvider>,
  payload: unknown = { blockHash: HASH },
  acceptedChange: Record<string, unknown> = {},
) {
  const requirement = await provider.createRequirement(paymentContext());
  const accepted = { ...(requirement.challenge.accepts[0] as object), ...acceptedChange };
  const submission = {
    method: 'x402' as const,
    payload: Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload })).toString('base64'),
  };
  return { requestId: 'req-1', resource: RESOURCE, requirement, submission };
}

const rejection = (result: PaymentResult) =>
  result.status === 'rejected' ? result.rejectionReason : result.status;

beforeEach(() => {
  vi.resetAllMocks();
  rpc.mockReturnValue(sendBlock());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toBe(RPC_URL);
      return new Response(JSON.stringify(await rpc(JSON.parse(init.body))), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(facilitatorCalls).not.toHaveBeenCalled();
});

describe('a Nano offer', () => {
  it('prices the challenge in raw XNO and names the family', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    expect(requirement.challenge.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: NETWORK,
      asset: 'XNO',
      payTo: PAY_TO,
      amount: PRICE_RAW.toString(),
      extra: {},
    });
    expect(provider.descriptor.supportedSpec).toContain('family=nano');
    expect(provider.descriptor.capabilities).toContain('exact-nano-send-block');
  });

  it('refuses a price in another currency, since XNO has no USD rate', async () => {
    const err = await makeProvider()
      .createRequirement(paymentContext('USD'))
      .catch((e: unknown) => e);
    expect(isCommerceError(err) && err.code).toBe('CONFIG_INVALID');
  });

  it.each<[string, Partial<X402MultiOfferProviderOptions['offers'][number]>, RegExp]>([
    ['a payee with a bad checksum', { payTo: `${PAY_TO.slice(0, -1)}1` }, /payTo.*nano_ address/],
    ['a token', { asset: 'USDC' }, /asset.*must be "XNO"/],
    ['an EVM transfer method', { assetTransferMethod: 'permit2' }, /EVM networks only/],
  ])('refuses %s at construction', (_label, change, message) => {
    expect(() =>
      makeProvider({
        offers: [
          {
            network: NETWORK,
            rpcUrl: RPC_URL,
            asset: 'XNO',
            assetDecimals: 30,
            payTo: PAY_TO,
            ...change,
          },
        ],
      }),
    ).toThrow(message);
  });

  it('verifies a confirmed send to payTo and settles it by reading it again', async () => {
    const provider = makeProvider();
    const context = await paidRequest(provider);
    const verification = await provider.verify(context);
    const replayKey = computeNanoReplayKey({ network: NETWORK, blockHash: HASH });
    expect(verification).toMatchObject({
      status: 'verified',
      payer: BUYER,
      payee: PAY_TO,
      amount: '0.001',
      currency: 'XNO',
      network: NETWORK,
      asset: 'XNO',
      replayKey,
    });
    const settled = await provider.settle({ ...context, verification });
    expect(settled).toMatchObject({
      status: 'settled',
      externalReference: HASH,
      payer: BUYER,
      replayKey,
      metadata: { amountBaseUnits: PRICE_RAW.toString() },
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith({ action: 'block_info', json_block: 'true', hash: HASH });
  });

  it.each<[string, () => void, unknown, Record<string, unknown>, string]>([
    ['no payment block', () => {}, {}, {}, 'invalid_exact_nano_payload_block_hash'],
    [
      'a malformed hash',
      () => {},
      { blockHash: 'xyz' },
      {},
      'invalid_exact_nano_payload_block_hash',
    ],
    [
      'a short amount',
      () => rpc.mockReturnValue(sendBlock({ amount: (PRICE_RAW - 1n).toString() })),
      { blockHash: HASH },
      {},
      'invalid_exact_nano_amount_insufficient',
    ],
    [
      'another recipient',
      () => rpc.mockReturnValue(sendBlock({}, BUYER)),
      { blockHash: HASH },
      {},
      'invalid_exact_nano_recipient_mismatch',
    ],
    [
      'an unconfirmed block',
      () => rpc.mockReturnValue(sendBlock({ confirmed: 'false' })),
      { blockHash: HASH },
      {},
      'invalid_exact_nano_block_unconfirmed',
    ],
    [
      'a receive block',
      () => rpc.mockReturnValue(sendBlock({ subtype: 'receive' })),
      { blockHash: HASH },
      {},
      'invalid_exact_nano_block_not_send',
    ],
    [
      'another network',
      () => {},
      { blockHash: HASH },
      { network: 'near:mainnet' },
      'invalid_network',
    ],
    [
      'another asset',
      () => {},
      { blockHash: HASH },
      { asset: 'USDC' },
      'invalid_payment_requirements',
    ],
    [
      'a lower echoed amount',
      () => {},
      { blockHash: HASH },
      { amount: '1' },
      'invalid_payment_requirements',
    ],
  ])('rejects %s', async (_label, arrange, payload, acceptedChange, reason) => {
    arrange();
    const provider = makeProvider();
    const result = await provider.verify(await paidRequest(provider, payload, acceptedChange));
    expect(rejection(result)).toBe(reason);
  });

  it('gives the same replay key to a hash presented in either case', async () => {
    const provider = makeProvider();
    const upper = await provider.verify(await paidRequest(provider));
    const lower = await provider.verify(
      await paidRequest(provider, { blockHash: HASH.toLowerCase() }),
    );
    expect(upper.replayKey).toBeDefined();
    expect(lower.replayKey).toBe(upper.replayKey);
  });

  it('fails closed and retryable when the node is down, in verify and settle', async () => {
    const provider = makeProvider();
    const context = await paidRequest(provider);
    const verification = await provider.verify(context);
    rpc.mockImplementation(() => {
      throw new Error('connection refused');
    });
    const verifyErr = await provider.verify(context).catch((e: unknown) => e);
    expect(isCommerceError(verifyErr) && verifyErr.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    const settleErr = await provider.settle({ ...context, verification }).catch((e: unknown) => e);
    expect(isCommerceError(settleErr) && settleErr.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    // Nothing was submitted, so the pipeline releases the attempt for a retry
    expect(isCommerceError(settleErr) && settleErr.details?.['settlementNotSubmitted']).toBe(true);
  });

  it('is ready only against a node of the live network', async () => {
    rpc.mockReturnValue({ network: 'live', node_vendor: 'Nano V28.0' });
    const live = await makeProvider().health?.();
    expect(live?.status).toBe('pass');
    rpc.mockReturnValue({ network: 'beta' });
    const beta = await makeProvider().health?.();
    expect(beta?.status).toBe('fail');
    expect(beta?.detail).toContain('live Nano network');
  });
});
