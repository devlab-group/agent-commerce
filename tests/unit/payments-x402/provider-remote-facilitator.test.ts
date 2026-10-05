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
import { isCommerceError } from '../../../src/core';
import { createPaymentProof } from '../../../src/payments/x402/client';
import {
  createX402PaymentProvider,
  type X402ProviderOptions,
} from '../../../src/payments/x402/provider';

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
    ...overrides,
    network: 'eip155:84532',
    rpcUrl: RPC_URL,
    asset: ASSET,
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    payTo: PAY_TO,
    facilitator: { mode: 'remote', url: FACILITATOR_URL, auth },
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
    const provider = makeProvider({ type: 'none' });
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
      transaction: '0xabc',
      network: 'eip155:84532',
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
    expect(settlement.externalReference).toBe('0xabc');
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
        network: 'eip155:84532',
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
          network: 'eip155:84532',
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
        networks: ['eip155:84532'],
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
