/**
 * The remote-facilitator path, mocked at the SDK's HTTP client. Everything
 * above `HTTPFacilitatorClient` is real (provider, binding, payload decoding,
 * guardrails), which shows that switching facilitators is configuration, not
 * code. The SDK's HTTP transport is not retested.
 */

import { x402Client } from '@x402/core/client';
import { FacilitatorResponseError } from '@x402/core/http';
import { type PaymentRequired, SettleError, VerifyError } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceResource, PaymentContext } from '../../../src/core';
import { isCommerceError, NOOP_LOGGER } from '../../../src/core';
import { createPaymentProof } from '../../../src/payments/x402/client';
import {
  createX402PaymentProvider,
  type X402ProviderOptions,
} from '../../../src/payments/x402/provider';
import { computePermit2ReplayKey } from '../../../src/payments/x402/replay-key';

const verifyMock = vi.fn();
const settleMock = vi.fn();
const getSupportedMock = vi.fn();
const constructorSpy = vi.fn();

// Declared inside the factory: `vi.mock` is hoisted above every top-level
// binding, so a class defined out here would not be initialized yet
vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    constructor(config: unknown) {
      constructorSpy(config);
    }
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

const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
// Not a well-known dev address: a remote facilitator makes this a testnet deployment
const PAY_TO = '0x1111111111111111111111111111111111111111' as const;
const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const RPC_URL = 'http://127.0.0.1:19321'; // never contacted: verify and settle are mocked
const FACILITATOR_URL = 'https://facilitator.example.com';

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USD' },
  exposedVia: ['http'],
  paymentMethods: ['x402'],
};

function paymentContext(): PaymentContext {
  return {
    requestId: 'req-1',
    resource: RESOURCE,
    amount: '0.01',
    currency: 'USD',
    requestedAt: new Date().toISOString(),
  };
}

function makeProvider(
  auth: { type: 'none' } | { type: 'bearer'; token: string },
  overrides: Partial<X402ProviderOptions> = {},
) {
  return createX402PaymentProvider({
    network: 'eip155:31337',
    rpcUrl: RPC_URL,
    asset: ASSET,
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    payTo: PAY_TO,
    facilitator: { mode: 'remote', url: FACILITATOR_URL, auth },
    ...overrides,
  });
}

async function proofFor(provider: Awaited<ReturnType<typeof makeProvider>>) {
  const requirement = await provider.createRequirement(paymentContext());
  const payload = await createPaymentProof({
    buyerPrivateKey: BUYER_PRIVATE_KEY,
    accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
  });
  return { requirement, payload };
}

describe('provider - remote facilitator', () => {
  beforeEach(() => {
    verifyMock.mockReset();
    settleMock.mockReset();
    getSupportedMock.mockReset();
    constructorSpy.mockReset();
  });

  it('holds no signing key and reports itself as a remote testnet deployment', () => {
    // Public Base Sepolia, which settles only in its USDC
    const provider = makeProvider(
      { type: 'none' },
      {
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        assetName: 'USDC',
      },
    );
    expect(provider.descriptor.capabilities).toContain('remote-facilitator');
    expect(provider.descriptor.capabilities).toContain('mode=testnet');
  });

  it('sends a bearer credential as the path-keyed object the SDK requires', async () => {
    makeProvider({ type: 'bearer', token: 'secret-token' });
    const config = constructorSpy.mock.calls[0]?.[0] as {
      url: string;
      createAuthHeaders: () => Promise<Record<string, Record<string, string>>>;
    };
    expect(config.url).toBe(FACILITATOR_URL);
    // The SDK throws on a flat headers object, so the per-path shape is what
    // this checks
    await expect(config.createAuthHeaders()).resolves.toEqual({
      verify: { Authorization: 'Bearer secret-token' },
      settle: { Authorization: 'Bearer secret-token' },
      supported: { Authorization: 'Bearer secret-token' },
    });
  });

  it('builds no auth callback when configured without credentials', () => {
    makeProvider({ type: 'none' });
    const config = constructorSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['createAuthHeaders']).toBeUndefined();
  });

  it('verifies and settles through the remote facilitator', async () => {
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true });
    settleMock.mockResolvedValueOnce({
      success: true,
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:31337',
      payer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });

    const verification = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
    });
    expect(verification.status).toBe('verified');

    const settlement = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
      verification,
    });
    expect(settlement.status).toBe('settled');
    expect(settlement.externalReference).toBe(`0x${'ab'.repeat(32)}`);
  });

  it.each([
    ['without a transaction hash', { transaction: '0xabc', network: 'eip155:31337' }],
    ['on another network', { transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:84532' }],
  ])('leaves a reported success %s with an unknown outcome', async (_label, response) => {
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true });
    settleMock.mockResolvedValueOnce({ success: true, ...response });
    const context = {
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402' as const, payload },
    };
    const verification = await provider.verify(context);
    await expect(provider.settle({ ...context, verification })).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('treats a facilitator that produced no verdict as unavailable, not as a bad payment', async () => {
    // A facilitator outage must not be recorded against the buyer
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockRejectedValueOnce(new FacilitatorResponseError('facilitator timed out'));

    await expect(
      provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('treats a settle() that never answered as uncertain, never as "did not happen"', async () => {
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true });
    const verification = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
    });
    // A settle() timeout is indeterminate: the facilitator may have completed
    // the transfer after we stopped waiting
    settleMock.mockRejectedValueOnce(new FacilitatorResponseError('settle timed out'));

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload },
        verification,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('rejects a payment the facilitator refused with a 400 and a reason', async () => {
    // The SDK throws a non-2xx verdict as `VerifyError` instead of returning it
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockRejectedValueOnce(
      new VerifyError(400, { isValid: false, invalidReason: 'insufficient_funds' }),
    );

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('insufficient_funds');
  });

  it.each([
    [401, 'our credential'],
    [403, 'our credential'],
    [429, 'rate limiting'],
    [500, 'an outage'],
  ])('treats a %i carrying a verdict body as unavailable (%s, not the buyer)', async (status) => {
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockRejectedValueOnce(
      new VerifyError(status, { isValid: false, invalidReason: 'unauthorized' }),
    );

    await expect(
      provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('treats a 400 with no reason as unavailable', async () => {
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockRejectedValueOnce(new VerifyError(400, { isValid: false }));

    await expect(
      provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  async function verifiedProof() {
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true });
    const verification = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
    });
    return { provider, requirement, payload, verification };
  }

  it('rejects a settlement the facilitator refused with a 400 and a reason', async () => {
    // The SDK throws a non-2xx settle body as `SettleError` instead of returning it
    const { provider, requirement, payload, verification } = await verifiedProof();
    settleMock.mockRejectedValueOnce(
      new SettleError(400, {
        success: false,
        errorReason: 'insufficient_funds',
        transaction: '',
        network: 'eip155:31337',
      }),
    );

    const result = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
      verification,
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('insufficient_funds');
    expect(result.externalReference).toBeUndefined();
  });

  it.each([
    [401, 'insufficient_funds', '', 'our credential'],
    [403, 'insufficient_funds', '', 'our credential'],
    [429, 'insufficient_funds', '', 'rate limiting'],
    [500, 'insufficient_funds', '', 'an outage'],
    [400, undefined, '', 'no reason named'],
    [400, 'insufficient_funds', `0x${'ab'.repeat(32)}`, 'a transaction that may have moved funds'],
  ])(
    'treats a settle %i with reason %s and transaction "%s" as unavailable (%s)',
    async (status, errorReason, transaction, _why) => {
      const { provider, requirement, payload, verification } = await verifiedProof();
      settleMock.mockRejectedValueOnce(
        new SettleError(status, {
          success: false,
          ...(errorReason !== undefined ? { errorReason } : {}),
          transaction,
          network: 'eip155:31337',
        }),
      );

      await expect(
        provider.settle({
          requestId: 'req-1',
          resource: RESOURCE,
          requirement,
          submission: { method: 'x402', payload },
          verification,
        }),
      ).rejects.toSatisfy(
        (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
      );
    },
  );

  it('still rejects a payment the facilitator judged invalid', async () => {
    const provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(provider);
    verifyMock.mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds' });

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('insufficient_funds');
  });
});

describe('provider - a proof must echo the offer it pays', () => {
  beforeEach(() => {
    verifyMock.mockReset();
  });

  type Decoded = {
    accepted: Record<string, unknown> & { extra: Record<string, unknown> };
    resource?: { url: string };
  };
  type Flow = NonNullable<X402ProviderOptions['paymentFlow']>;

  async function verifyTampered(flow: Flow, tamper: (decoded: Decoded) => void) {
    const provider = makeProvider({ type: 'none' }, { paymentFlow: flow });
    const { requirement, payload } = await proofFor(provider);
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Decoded;
    tamper(decoded);
    verifyMock.mockResolvedValue({ isValid: true });
    return provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: {
        method: 'x402',
        payload: Buffer.from(JSON.stringify(decoded)).toString('base64'),
      },
    });
  }

  const mismatches: ReadonlyArray<[string, Flow, (decoded: Decoded) => void]> = [
    [
      'amount',
      'authorization',
      (d) => {
        d.accepted['amount'] = '9999';
      },
    ],
    [
      'asset',
      'authorization',
      (d) => {
        d.accepted['asset'] = '0x2222222222222222222222222222222222222222';
      },
    ],
    [
      'payTo',
      'authorization',
      (d) => {
        d.accepted['payTo'] = '0x2222222222222222222222222222222222222222';
      },
    ],
    [
      'extra.name',
      'authorization',
      (d) => {
        d.accepted.extra['name'] = 'OtherUSDC';
      },
    ],
    [
      'extra.assetTransferMethod',
      'authorization',
      (d) => {
        delete d.accepted.extra['assetTransferMethod'];
      },
    ],
    [
      'extra.paymentFlow of an upfront offer on an authorization resource',
      'authorization',
      (d) => {
        d.accepted.extra['paymentFlow'] = 'upfront';
      },
    ],
    [
      'extra.paymentFlow of an authorization offer on an upfront resource',
      'upfront',
      (d) => {
        delete d.accepted.extra['paymentFlow'];
      },
    ],
    [
      'resource.url',
      'authorization',
      (d) => {
        d.resource = { url: 'resource://agent-commerce/other' };
      },
    ],
  ];

  it.each(mismatches)(
    'refuses a mismatched %s without calling the facilitator',
    async (_field, flow, tamper) => {
      const result = await verifyTampered(flow, tamper);
      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('invalid_payment_requirements');
      expect(verifyMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'scheme',
      'unsupported_scheme',
      (d: Decoded) => {
        d.accepted['scheme'] = 'upto';
      },
    ],
    [
      'network',
      'invalid_network',
      (d: Decoded) => {
        d.accepted['network'] = 'eip155:8453';
      },
    ],
  ])('refuses a mismatched %s without calling the facilitator', async (_field, reason, tamper) => {
    const result = await verifyTampered('authorization', tamper);
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe(reason);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('accepts differences the SDK resource server also ignores, and address case', async () => {
    const result = await verifyTampered('authorization', (d) => {
      d.accepted['payTo'] = String(d.accepted['payTo']).toLowerCase();
      d.accepted['asset'] = String(d.accepted['asset']).toLowerCase();
      d.accepted.extra['clientNote'] = 'added by the client';
    });
    expect(result.status).toBe('verified');
  });

  it.each(['authorization', 'upfront'] as const)(
    'accepts a payload built by the SDK client under the %s flow',
    async (flow) => {
      const provider = makeProvider({ type: 'none' }, { paymentFlow: flow });
      const requirement = await provider.createRequirement(paymentContext());
      const client = new x402Client();
      registerExactEvmScheme(client, {
        signer: privateKeyToAccount(BUYER_PRIVATE_KEY),
        networks: ['eip155:31337'],
      });
      client.setSpendControls(false); // the test token is not in the SDK's list
      const sdkPayload = await client.createPaymentPayload(
        requirement.challenge.envelope as unknown as PaymentRequired,
      );
      // The SDK client echoes the challenge's resource
      expect(sdkPayload.resource?.url).toMatch(/^resource:\/\/agent-commerce\//);
      verifyMock.mockResolvedValueOnce({ isValid: true });

      const result = await provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: {
          method: 'x402',
          payload: Buffer.from(JSON.stringify(sdkPayload)).toString('base64'),
        },
      });
      expect(result.status).toBe('verified');
    },
  );
});

describe('provider - several offers', () => {
  // Three tokens to three payees on one chain, so every offer is distinct
  const OFFERS = [
    { asset: ASSET, payTo: PAY_TO },
    {
      asset: '0x2222222222222222222222222222222222222222',
      payTo: '0x3333333333333333333333333333333333333333',
    },
    {
      asset: '0x4444444444444444444444444444444444444444',
      payTo: '0x5555555555555555555555555555555555555555',
    },
  ] as const;

  const makeMultiProvider = () =>
    createX402PaymentProvider({
      offers: OFFERS.map((offer) => ({
        ...offer,
        network: 'eip155:31337',
        rpcUrl: RPC_URL,
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
      })),
      facilitator: { mode: 'remote', url: FACILITATOR_URL, auth: { type: 'none' } },
    });

  // A proof built by the SDK client for the offer `pick` chooses
  async function sdkProof(envelope: unknown, pick: number) {
    const client = new x402Client((_version, accepts) => accepts[pick] as never);
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(BUYER_PRIVATE_KEY),
      networks: ['eip155:31337'],
    });
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(envelope as PaymentRequired);
    return {
      method: 'x402' as const,
      payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
    };
  }

  beforeEach(() => {
    verifyMock.mockReset();
    settleMock.mockReset();
  });

  it('offers every option under one resource URL and names no single destination', async () => {
    const requirement = await makeMultiProvider().createRequirement(paymentContext());
    expect(requirement.challenge.accepts.map((a) => a['payTo'])).toEqual(
      OFFERS.map((o) => o.payTo),
    );
    expect((requirement.challenge.envelope as unknown as PaymentRequired).resource.url).toBe(
      'resource://agent-commerce/resources/demo.report',
    );
    expect(requirement.destination).toBeUndefined();
    expect(requirement.network).toBeUndefined();
    expect(requirement.asset).toBeUndefined();
  });

  it.each([0, 1, 2])(
    'verifies and settles the offer the SDK client chose: offer %i',
    async (pick) => {
      const provider = makeMultiProvider();
      const requirement = await provider.createRequirement(paymentContext());
      const submission = await sdkProof(requirement.challenge.envelope, pick);
      const context = { requestId: 'req-1', resource: RESOURCE, requirement, submission };

      const selected = await provider.selectRequirement?.(context);
      if (!selected) throw new Error('a provider with several offers selects one');
      const offer = OFFERS[pick] as (typeof OFFERS)[number];
      expect(selected).toMatchObject({
        id: requirement.id,
        destination: offer.payTo,
        network: 'eip155:31337',
        asset: offer.asset,
        challenge: requirement.challenge,
      });

      verifyMock.mockResolvedValueOnce({ isValid: true });
      const verification = await provider.verify({ ...context, requirement: selected });
      expect(verification).toMatchObject({ status: 'verified', asset: offer.asset });
      expect(verification.payee?.toLowerCase()).toBe(offer.payTo);

      settleMock.mockResolvedValueOnce({
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        network: 'eip155:31337',
      });
      const settled = await provider.settle({ ...context, requirement: selected, verification });
      expect(settled.status).toBe('settled');
      // The facilitator settles exactly the chosen offer
      expect(settleMock.mock.calls[0]?.[1]).toEqual(requirement.challenge.accepts[pick]);
    },
  );

  it('leaves the requirement unselected when the echo matches no offer, and verify rejects it', async () => {
    const provider = makeMultiProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await sdkProof(requirement.challenge.envelope, 1);
    const decoded = JSON.parse(Buffer.from(proof.payload, 'base64').toString('utf8'));
    decoded.accepted.payTo = '0x6666666666666666666666666666666666666666';
    const submission = {
      method: 'x402' as const,
      payload: Buffer.from(JSON.stringify(decoded)).toString('base64'),
    };
    const context = { requestId: 'req-1', resource: RESOURCE, requirement, submission };

    expect(await provider.selectRequirement?.(context)).toBe(requirement);
    const result = await provider.verify(context);
    expect(result.rejectionReason).toBe('invalid_payment_requirements');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('selects per request, so concurrent buyers can pay different offers', async () => {
    const provider = makeMultiProvider();
    const [first, last] = await Promise.all(
      [0, 2].map(async (pick) => {
        const requirement = await provider.createRequirement(paymentContext());
        const submission = await sdkProof(requirement.challenge.envelope, pick);
        return provider.selectRequirement?.({
          requestId: 'r',
          resource: RESOURCE,
          requirement,
          submission,
        });
      }),
    );
    expect(first?.destination).toBe(OFFERS[0].payTo);
    expect(last?.destination).toBe(OFFERS[2].payTo);
  });
});

describe('provider - Permit2 offers', () => {
  type Permit2Proof = {
    payload: {
      permit2Authorization: {
        from: string;
        spender: string;
        nonce: string;
        permitted: { token: string; amount: string };
        witness: { to: string };
      };
    };
    extensions?: Record<string, unknown>;
    resource?: unknown;
  };

  const buyer = privateKeyToAccount(BUYER_PRIVATE_KEY);

  // No token domain: Permit2 signs its own
  const warn = vi.fn();
  const makePermit2Provider = () =>
    createX402PaymentProvider({
      network: 'eip155:31337',
      rpcUrl: RPC_URL,
      asset: ASSET,
      assetDecimals: 6,
      payTo: PAY_TO,
      assetTransferMethod: 'permit2',
      facilitator: { mode: 'remote', url: FACILITATOR_URL, auth: { type: 'none' } },
      logger: { ...NOOP_LOGGER, warn },
    });

  async function signedProof(provider: ReturnType<typeof makePermit2Provider>) {
    const requirement = await provider.createRequirement(paymentContext());
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: buyer, networks: ['eip155:31337'] });
    client.setSpendControls(false);
    const envelope = requirement.challenge.envelope as unknown as PaymentRequired;
    const proof = (await client.createPaymentPayload(envelope)) as unknown as Permit2Proof;
    return { requirement, proof };
  }

  const submission = (proof: unknown) => ({
    method: 'x402' as const,
    payload: Buffer.from(JSON.stringify(proof)).toString('base64'),
  });

  beforeEach(() => {
    verifyMock.mockReset();
    settleMock.mockReset();
  });

  it('names the method in the offer and the descriptor, without a token domain', async () => {
    const provider = makePermit2Provider();
    const requirement = await provider.createRequirement(paymentContext());
    expect(requirement.challenge.accepts[0]?.['extra']).toEqual({ assetTransferMethod: 'permit2' });
    expect(provider.descriptor.capabilities).toContain('permit2');
  });

  it('refuses an EIP-3009 offer without the token domain', () => {
    expect(() =>
      createX402PaymentProvider({
        network: 'eip155:31337',
        rpcUrl: RPC_URL,
        asset: ASSET,
        assetDecimals: 6,
        payTo: PAY_TO,
        facilitator: { mode: 'remote', url: FACILITATOR_URL, auth: { type: 'none' } },
      }),
    ).toThrow(/EIP-3009 offer needs "assetName" and "assetVersion"/);
  });

  it('verifies and settles an SDK-signed payload, forwarding no extensions', async () => {
    const provider = makePermit2Provider();
    const { requirement, proof } = await signedProof(provider);
    const auth = proof.payload.permit2Authorization;
    // An unadvertised gas-sponsoring extension never reaches the facilitator
    proof.extensions = { eip2612GasSponsoring: { info: { from: buyer.address } } };
    verifyMock.mockResolvedValueOnce({ isValid: true });
    settleMock.mockResolvedValueOnce({
      success: true,
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:31337',
      payer: buyer.address,
    });

    const context = {
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: submission(proof),
    };
    const verification = await provider.verify(context);
    expect(verification).toMatchObject({
      status: 'verified',
      payer: buyer.address,
      payee: PAY_TO,
      amount: '0.01',
      replayKey: computePermit2ReplayKey({
        chainId: 31337,
        owner: buyer.address,
        nonce: auth.nonce,
      }),
    });
    const forwarded = verifyMock.mock.calls[0]?.[0] as Permit2Proof;
    expect(forwarded.payload.permit2Authorization).toEqual(auth);
    expect(forwarded).not.toHaveProperty('extensions');
    expect(forwarded).not.toHaveProperty('resource');

    const settlement = await provider.settle({ ...context, verification });
    expect(settlement.status).toBe('settled');
    expect(settlement.metadata).toEqual({ amountBaseUnits: '10000' });
    expect(settleMock.mock.calls[0]?.[0]).not.toHaveProperty('extensions');
  });

  const OTHER = '0x2222222222222222222222222222222222222222';
  it.each<[string, (auth: Permit2Proof['payload']['permit2Authorization']) => void]>([
    [
      'invalid_permit2_spender',
      (auth) => {
        auth.spender = OTHER;
      },
    ],
    [
      'permit2_token_mismatch',
      (auth) => {
        auth.permitted.token = OTHER;
      },
    ],
    [
      'invalid_permit2_recipient_mismatch',
      (auth) => {
        auth.witness.to = OTHER;
      },
    ],
    [
      'permit2_amount_mismatch',
      (auth) => {
        auth.permitted.amount = '10001';
      },
    ],
  ])('refuses %s before the facilitator sees it', async (reason, tamper) => {
    const provider = makePermit2Provider();
    const { requirement, proof } = await signedProof(provider);
    tamper(proof.payload.permit2Authorization);
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: submission(proof),
    });
    expect(result.rejectionReason).toBe(reason);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  // The SDK's Permit2 path returns every throw from the broadcast call with no
  // hash, the catch-all with the message appended
  it.each([
    [
      'the catch-all with a message, as an unknown outcome',
      'invalid_exact_evm_transaction_failed: request timed out. URL: https://rpc.example/v2/RPC-KEY',
      'throws',
    ],
    ['a recognized Permit2 revert, as a refusal', 'permit2_invalid_nonce', 'rejected'],
  ])('settle() treats a failure without a hash, %s', async (_label, errorReason, outcome) => {
    const provider = makePermit2Provider();
    const { requirement, proof } = await signedProof(provider);
    verifyMock.mockResolvedValueOnce({ isValid: true });
    settleMock.mockResolvedValueOnce({
      success: false,
      errorReason,
      transaction: '',
      network: 'eip155:31337',
    });
    const context = {
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: submission(proof),
    };
    const settled = provider.settle({ ...context, verification: await provider.verify(context) });
    if (outcome === 'throws') {
      await expect(settled).rejects.toSatisfy(
        (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
      );
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('RPC-KEY');
    } else {
      await expect(settled).resolves.toMatchObject({
        status: 'rejected',
        rejectionReason: errorReason,
      });
    }
  });

  it('refuses an EIP-3009 payload for a Permit2 offer', async () => {
    const provider = makePermit2Provider();
    const requirement = await provider.createRequirement(paymentContext());
    const eip3009 = await proofFor(makeProvider({ type: 'none' }));
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: eip3009.payload },
    });
    expect(result.rejectionReason).toBe('unsupported_scheme');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('refuses a payload carrying both authorizations, which the SDK would settle through Permit2', async () => {
    const eip3009Provider = makeProvider({ type: 'none' });
    const { requirement, payload } = await proofFor(eip3009Provider);
    const { proof } = await signedProof(makePermit2Provider());
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    decoded.payload.permit2Authorization = proof.payload.permit2Authorization;
    const result = await eip3009Provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: submission(decoded),
    });
    expect(result.rejectionReason).toBe('unsupported_scheme');
    expect(verifyMock).not.toHaveBeenCalled();
  });
});
