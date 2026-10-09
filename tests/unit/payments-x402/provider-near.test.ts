/**
 * Tests NEAR offers, delegate validation, settlement classification and RPC
 * readiness, with the remote facilitator mocked at the SDK HTTP client.
 */
import { KeyPair } from '@near-js/crypto';
import type { SupportedResponse } from '@x402/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceResource, PaymentContext } from '../../../src/core';
import { isCommerceError } from '../../../src/core';
import {
  createX402PaymentProvider,
  type X402MultiOfferProviderOptions,
} from '../../../src/payments/x402/provider';
import { computeNearReplayKey } from '../../../src/payments/x402/replay-key';
import { buildSignedDelegate } from '../../fixtures/x402/near-delegate';

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

const NETWORK = 'near:testnet';
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const PAY_TO = 'merchant.testnet';
const BUYER = 'buyer.testnet';
const RPC_URL = 'https://near-testnet.example';
const TX_HASH = 'FGgDFXFA3UCj533aWRMtV6iL3kVzLmgJKNt22HK9A7Z5';

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

const supported = (network: `${string}:${string}` = NETWORK): SupportedResponse => ({
  kinds: [{ x402Version: 2, scheme: 'exact', network }],
  extensions: [],
  signers: { 'near:*': ['relayer.testnet'] },
});

function makeProvider(overrides: Partial<X402MultiOfferProviderOptions> = {}) {
  return createX402PaymentProvider({
    offers: [{ network: NETWORK, rpcUrl: RPC_URL, asset: USDC, assetDecimals: 6, payTo: PAY_TO }],
    facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
    ...overrides,
  });
}

async function paidRequest(
  provider: ReturnType<typeof makeProvider>,
  delegate: Parameters<typeof buildSignedDelegate>[0] = {},
) {
  const requirement = await provider.createRequirement(paymentContext());
  const accepted = requirement.challenge.accepts[0] as Record<string, unknown>;
  const keyPair = delegate.keyPair ?? KeyPair.fromRandom('ed25519');
  const { signedDelegateAction } = await buildSignedDelegate({
    senderId: BUYER,
    ftReceiver: PAY_TO,
    ...delegate,
    keyPair,
  });
  const submission = {
    method: 'x402' as const,
    payload: Buffer.from(
      JSON.stringify({ x402Version: 2, accepted, payload: { signedDelegateAction } }),
    ).toString('base64'),
  };
  return {
    keyPair,
    context: { requestId: 'req-1', resource: RESOURCE, requirement, submission },
  };
}

const unavailable = (err: unknown) =>
  isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE';

beforeEach(() => {
  vi.resetAllMocks();
  getSupportedMock.mockResolvedValue(supported());
});

describe('a NEAR offer', () => {
  it('carries no scheme-specific extra and names the family', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    expect(requirement.challenge.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '10000',
      extra: {},
    });
    expect(provider.descriptor.supportedSpec).toContain('family=near');
    expect(provider.descriptor.capabilities).toContain('exact-near');
  });

  it.each<[string, Partial<X402MultiOfferProviderOptions['offers'][number]>, RegExp]>([
    ['a payee that is not an account ID', { payTo: 'Merchant.testnet' }, /payTo.*NEAR account ID/],
    ['an EVM transfer method', { assetTransferMethod: 'permit2' }, /EVM networks only/],
  ])('refuses %s at construction', (_label, change, message) => {
    expect(() =>
      makeProvider({
        offers: [
          {
            network: NETWORK,
            rpcUrl: RPC_URL,
            asset: USDC,
            assetDecimals: 6,
            payTo: PAY_TO,
            ...change,
          },
        ],
      }),
    ).toThrow(message);
  });

  // The NEAR facilitator refuses every payment under any other timeout
  it.each([0, -1, 1.5])('refuses maxTimeoutSeconds %s', (maxTimeoutSeconds) => {
    expect(() => makeProvider({ maxTimeoutSeconds })).toThrow(/maxTimeoutSeconds/);
  });

  it('refuses the in-process facilitator', () => {
    expect(() =>
      makeProvider({ facilitator: { mode: 'local', signerPrivateKey: `0x${'11'.repeat(32)}` } }),
    ).toThrow(/serves the local Anvil chain/);
  });
});

describe('verify()', () => {
  it('passes a delegate for the offered transfer on, keyed by sender, key and nonce', async () => {
    const provider = makeProvider();
    const { context, keyPair } = await paidRequest(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true, payer: BUYER });

    expect(await provider.verify(context)).toMatchObject({
      status: 'verified',
      payer: BUYER,
      payee: PAY_TO,
      amount: '0.01',
      network: NETWORK,
      asset: USDC,
      replayKey: computeNearReplayKey({
        network: NETWORK,
        senderId: BUYER,
        publicKey: keyPair.getPublicKey().toString(),
        nonce: 5n,
      }),
    });
  });

  it.each<[string, Parameters<typeof buildSignedDelegate>[0], string]>([
    [
      'another recipient',
      { ftReceiver: 'attacker.testnet' },
      'invalid_exact_near_payload_recipient_mismatch',
    ],
    [
      'another token',
      { receiverId: 'usdt.testnet' },
      'invalid_exact_near_payload_token_contract_mismatch',
    ],
    ['another amount', { amount: '9999' }, 'invalid_exact_near_payload_amount_mismatch'],
    ['no deposit', { deposit: 0n }, 'invalid_exact_near_payload_attached_deposit'],
  ])(
    'refuses a delegate for %s before the facilitator sees it',
    async (_label, delegate, reason) => {
      const provider = makeProvider();
      const { context } = await paidRequest(provider, delegate);
      expect((await provider.verify(context)).rejectionReason).toBe(reason);
      expect(verifyMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    'invalid_exact_near_access_key_lookup_failed',
    'invalid_exact_near_current_block_height_unavailable',
    'unexpected_verify_error',
  ])('treats %s, the facilitator failing to read the chain, as no verdict', async (reason) => {
    const provider = makeProvider();
    const { context } = await paidRequest(provider);
    verifyMock.mockResolvedValueOnce({ isValid: false, invalidReason: reason });
    await expect(provider.verify(context)).rejects.toSatisfy(unavailable);
  });

  it('records a refusal the facilitator found in the payment', async () => {
    const provider = makeProvider();
    const { context } = await paidRequest(provider);
    verifyMock.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'invalid_exact_near_payload_delegate_action_nonce_already_used',
    });
    expect((await provider.verify(context)).rejectionReason).toBe(
      'invalid_exact_near_payload_delegate_action_nonce_already_used',
    );
  });
});

describe('settle()', () => {
  async function settleWith(response: Record<string, unknown>) {
    const provider = makeProvider();
    const { context } = await paidRequest(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true, payer: BUYER });
    const verification = await provider.verify(context);
    settleMock.mockResolvedValueOnce({ network: NETWORK, ...response });
    return provider.settle({ ...context, verification });
  }

  it('settles with the outer transaction hash once the inner transfer succeeded', async () => {
    await expect(
      settleWith({ success: true, transaction: TX_HASH, payer: BUYER }),
    ).resolves.toMatchObject({
      status: 'settled',
      externalReference: TX_HASH,
      payer: BUYER,
      metadata: { amountBaseUnits: '10000' },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'a throw after the delegate may have been submitted',
      { success: false, transaction: '', errorReason: 'settlement_failed' },
    ],
    [
      'a settlement already in flight',
      { success: false, transaction: '', errorReason: 'duplicate_settlement' },
    ],
    [
      'the facilitator failing to read the chain',
      { success: false, transaction: '', errorReason: 'invalid_exact_near_balance_check_failed' },
    ],
    // The spec leaves a failure's reason to the facilitator, with an empty
    // transaction even after a submission
    [
      "a reason outside the SDK's pre-submission vocabulary",
      { success: false, transaction: '', errorReason: 'relayer_rpc_timeout' },
    ],
    ['a failure without a reason', { success: false, transaction: '' }],
    ['a success without a NEAR hash', { success: true, transaction: `0x${'ab'.repeat(32)}` }],
    [
      'a success on another network',
      { success: true, transaction: TX_HASH, network: 'near:mainnet' },
    ],
  ])('leaves the outcome unknown for %s', async (_label, response) => {
    await expect(settleWith(response)).rejects.toSatisfy(unavailable);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'an inner transfer that failed on chain',
      { success: false, transaction: TX_HASH, errorReason: 'settlement_failed' },
    ],
    [
      'a refusal before submission',
      { success: false, transaction: '', errorReason: 'insufficient_funds' },
    ],
    [
      'a delegate whose window passed before submission',
      {
        success: false,
        transaction: '',
        errorReason: 'invalid_exact_near_payload_delegate_action_expired',
      },
    ],
    [
      "the SDK's fallback for a failed check at settle",
      { success: false, transaction: '', errorReason: 'verification_failed' },
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
      const { method, params } = JSON.parse(init.body) as {
        method: string;
        params: Record<string, unknown>;
      };
      const answer = rpc(method, params) as { result?: unknown; error?: unknown };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...answer }));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const view = (value: unknown) => ({
    result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1 },
  });

  // A healthy testnet RPC; `change` overrides single answers
  function chain(change: Record<string, unknown> = {}) {
    rpc.mockImplementation((method: string, params: Record<string, unknown>) => {
      const answers: Record<string, unknown> = {
        status: { result: { chain_id: 'testnet' } },
        view_account: { result: { code_hash: '5tvUMpoLY7fpqRUMBDtEvDWrPmWRHsCV8kcvb5nx8Byp' } },
        ft_metadata: view({ spec: 'ft-1.0.0', decimals: 6 }),
        storage_balance_of: view({ total: '1250000000000000000000', available: '0' }),
        ...change,
      };
      if (method === 'status') return answers['status'];
      const key = (params['method_name'] ?? params['request_type']) as string;
      return answers[key];
    });
  }

  it('passes for the named chain, a token with the configured decimals and a registered payee', async () => {
    chain();
    const health = await makeProvider().health();
    expect(health.status).toBe('pass');
    expect(health.detail).toContain(`storage for ${PAY_TO}`);
  });

  it('passes for a token without NEP-145 storage management', async () => {
    chain({
      storage_balance_of: {
        error: { cause: { info: { vm_error: '{"MethodResolveError":"MethodNotFound"}' } } },
      },
    });
    expect((await makeProvider().health()).status).toBe('pass');
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      'an RPC serving another chain',
      { status: { result: { chain_id: 'mainnet' } } },
      /serves chain mainnet, expected testnet/,
    ],
    [
      'a token account without code',
      { view_account: { result: { code_hash: '11111111111111111111111111111111' } } },
      /No contract code/,
    ],
    [
      'a token with other decimals',
      { ft_metadata: view({ decimals: 24 }) },
      /has 24 decimals, configured 6/,
    ],
    ['an unregistered payee', { storage_balance_of: view(null) }, /no storage registered/],
  ])('fails for %s', async (_label, change, detail) => {
    chain(change);
    const health = await makeProvider().health();
    expect(health.status).toBe('fail');
    expect(health.detail).toMatch(detail);
  });

  it('fails for a facilitator that does not list the network', async () => {
    chain();
    getSupportedMock.mockResolvedValue(supported('near:mainnet'));
    const health = await makeProvider().health();
    expect(health.status).toBe('fail');
    expect(health.detail).toMatch(/does not advertise/);
  });
});
