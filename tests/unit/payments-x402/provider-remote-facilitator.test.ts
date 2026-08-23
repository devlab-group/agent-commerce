/**
 * The remote-facilitator path, mocked at the HTTP client boundary.
 *
 * Everything above `HTTPFacilitatorClient` is real here — the provider, the
 * binding, the payload decoding, the guardrails — so this proves the claim
 * that moving between a local and a remote facilitator is configuration, not
 * an application-code change. The HTTP transport itself is the SDK's, and is
 * not re-tested here.
 */

import { FacilitatorResponseError } from '@x402/core/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceResource, PaymentContext } from '../../../src/core/index.js';
import { isCommerceError } from '../../../src/core/index.js';
import { createPaymentProof } from '../../../src/payments/x402/client.js';
import { createX402PaymentProvider } from '../../../src/payments/x402/provider.js';

const verifyMock = vi.fn();
const settleMock = vi.fn();
const getSupportedMock = vi.fn();
const constructorSpy = vi.fn();

// Declared inside the factory: `vi.mock` is hoisted above every top-level
// binding in this file, so a class defined out here is not initialised yet.
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
/** Not a well-known dev address: a remote facilitator makes this a testnet deployment. */
const PAY_TO = '0x1111111111111111111111111111111111111111' as const;
const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const RPC_URL = 'http://127.0.0.1:19321'; // never contacted — verify/settle are mocked
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

function makeProvider(auth: { type: 'none' } | { type: 'bearer'; token: string }) {
  return createX402PaymentProvider({
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
    rpcUrl: RPC_URL,
    accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
  });
  return { requirement, payload };
}

describe('provider — remote facilitator', () => {
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
    // A flat headers object throws inside the SDK rather than silently
    // dropping auth on every request, so the shape is the whole point.
    await expect(config.createAuthHeaders()).resolves.toEqual({
      verify: { Authorization: 'Bearer secret-token' },
      settle: { Authorization: 'Bearer secret-token' },
      supported: { Authorization: 'Bearer secret-token' },
    });
  });

  it('builds no auth callback at all when the facilitator takes no credential', () => {
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
    // Blaming the buyer for the facilitator being down would record their
    // attempt as their fault and burn an authorisation that was never checked.
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
    // The SDK is explicit that a settle() timeout is indeterminate: the
    // facilitator may have completed the transfer after we stopped waiting.
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
