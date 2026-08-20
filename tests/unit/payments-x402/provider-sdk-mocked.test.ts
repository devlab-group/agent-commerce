/**
 * Exercises the branches of provider.ts that depend on what the x402 SDK
 * (`x402/facilitator`) or the underlying RPC client return — success,
 * rejection-with-reason, rejection-without-reason, and various thrown-error
 * shapes. These are mocked at the SDK/client boundary rather than driven
 * through a live chain so this stays a fast, deterministic unit test; real,
 * unmocked on-chain settlement is proven separately in tests/e2e/payment.
 */

import {
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceResource, PaymentContext } from '../../../src/core/index.js';
import { isCommerceError } from '../../../src/core/index.js';
import { createPaymentProof } from '../../../src/payments/x402/client.js';
import { createX402PaymentProvider } from '../../../src/payments/x402/provider.js';

const verifyMock = vi.fn();
const settleMock = vi.fn();

vi.mock('x402/facilitator', () => ({
  verify: (...args: unknown[]) => verifyMock(...args),
  settle: (...args: unknown[]) => settleMock(...args),
}));

const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const RPC_URL = 'http://127.0.0.1:19321'; // never actually contacted — verify/settle are mocked

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

describe('provider — SDK-boundary branches (mocked x402/facilitator)', () => {
  beforeEach(() => {
    verifyMock.mockReset();
    settleMock.mockReset();
  });

  function makeProvider() {
    return createX402PaymentProvider({
      network: 'base-sepolia',
      rpcUrl: RPC_URL,
      asset: ASSET,
      assetName: 'MockUSDC',
      assetVersion: '2',
      assetDecimals: 6,
      payTo: PAY_TO,
      facilitator: { mode: 'local', signerPrivateKey: BUYER_PRIVATE_KEY },
    });
  }

  it('createRequirement falls back to the resource name when description is absent', async () => {
    const provider = makeProvider();
    const { description, ...resourceWithoutDescription } = RESOURCE;
    const requirement = await provider.createRequirement({
      ...paymentContext(),
      resource: resourceWithoutDescription,
    });
    const accepted = requirement.challenge.accepts[0] as Record<string, unknown>;
    expect(accepted['description']).toBe(RESOURCE.name);
  });

  it('rejects at construction time for a non-integer or negative assetDecimals', async () => {
    expect(() => createX402PaymentProvider({ ...baseOptions(), assetDecimals: -1 })).toThrow();
    expect(() => createX402PaymentProvider({ ...baseOptions(), assetDecimals: 1.5 })).toThrow();

    function baseOptions() {
      return {
        network: 'base-sepolia',
        rpcUrl: RPC_URL,
        asset: ASSET,
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: PAY_TO,
        facilitator: { mode: 'local' as const, signerPrivateKey: BUYER_PRIVATE_KEY },
      };
    }
  });

  it('rejects when the requirement has an empty accepts array', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const emptied = { ...requirement, challenge: { ...requirement.challenge, accepts: [] } };
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement: emptied,
      submission: { method: 'x402', payload: 'irrelevant' },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('missing_payment_requirements');
  });

  it('rejects a malformed "to" address while "from" is valid', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    decoded.payload.authorization.to = 'not-an-address';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64');

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: tampered },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('malformed_payment_payload');
  });

  it('verify() returns verified with a replayKey when the SDK reports isValid', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    verifyMock.mockResolvedValueOnce({ isValid: true });

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('verified');
    expect(result.replayKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.payer?.toLowerCase()).toBe('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
    expect(verifyMock).toHaveBeenCalledOnce();
  });

  it('verify() falls back to "invalid_payment" when the SDK gives no invalidReason', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    verifyMock.mockResolvedValueOnce({ isValid: false });

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('invalid_payment');
  });

  it('verify() returns rejected("unexpected_verify_error") when the SDK throws a non-connection error', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    verifyMock.mockRejectedValueOnce(new TypeError('something exploded'));

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('unexpected_verify_error');
  });

  it('verify() throws PAYMENT_PROVIDER_UNAVAILABLE when the SDK throws a connection-shaped error', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    verifyMock.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    await expect(
      provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('settle() returns settled with externalReference on SDK success', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockResolvedValueOnce({
      success: true,
      transaction: '0xdeadbeef',
      network: 'base-sepolia',
      payer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });

    const result = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: {
        status: 'verified',
        provider: 'x402',
        amount: '0.01',
        currency: 'USD',
        network: 'base-sepolia',
        asset: ASSET,
        replayKey: '0xabc',
      },
    });
    expect(result.status).toBe('settled');
    expect(result.externalReference).toBe('0xdeadbeef');
    expect(result.payee).toBe(PAY_TO);
    expect(result.network).toBe('base-sepolia');
    expect(result.asset).toBe(ASSET);
    expect(result.replayKey).toBe('0xabc');
    expect(result.settledAt).toBeDefined();
  });

  it('settle() omits payer when the SDK success response does not include one', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockResolvedValueOnce({
      success: true,
      transaction: '0xfeedface',
      network: 'base-sepolia',
    });

    const result = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
    });
    expect(result.status).toBe('settled');
    expect(result.payer).toBeUndefined();
  });

  it('settle() returns rejected with the SDK errorReason on failure, defaulting when absent', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    settleMock.mockResolvedValueOnce({
      success: false,
      network: 'base-sepolia',
      errorReason: 'insufficient_funds',
      payer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });
    const withReason = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: {
        status: 'verified',
        provider: 'x402',
        amount: '0.01',
        currency: 'USD',
        asset: ASSET,
        replayKey: '0xdef',
      },
    });
    expect(withReason.status).toBe('rejected');
    expect(withReason.rejectionReason).toBe('insufficient_funds');
    expect(withReason.payer).toBe('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    expect(withReason.asset).toBe(ASSET);
    expect(withReason.replayKey).toBe('0xdef');

    settleMock.mockResolvedValueOnce({ success: false, network: 'base-sepolia' });
    const withoutReason = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
    });
    expect(withoutReason.status).toBe('rejected');
    expect(withoutReason.rejectionReason).toBe('settlement_failed');
  });

  it('settle() classifies an on-chain revert distinctly from an unexpected error', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    settleMock.mockRejectedValueOnce(
      new ContractFunctionRevertedError({ abi: [], functionName: 'transferWithAuthorization' }),
    );
    const reverted = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: {
        status: 'verified',
        provider: 'x402',
        amount: '0.01',
        currency: 'USD',
        network: 'base-sepolia',
        asset: ASSET,
        replayKey: '0xreverted',
      },
    });
    expect(reverted.status).toBe('rejected');
    expect(reverted.rejectionReason).toBe('transaction_reverted');
    expect(reverted.network).toBe('base-sepolia');
    expect(reverted.asset).toBe(ASSET);
    expect(reverted.replayKey).toBe('0xreverted');

    settleMock.mockRejectedValueOnce(new TypeError('boom'));
    const unexpected = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
    });
    expect(unexpected.status).toBe('rejected');
    expect(unexpected.rejectionReason).toBe('unexpected_settle_error');
  });

  it('settle() throws PAYMENT_PROVIDER_UNAVAILABLE when the SDK throws a connection-shaped error', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:19321'));

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
        verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it('settle() attaches transactionHash to PAYMENT_PROVIDER_UNAVAILABLE when the broadcast succeeded but confirmation timed out', async () => {
    // Simulates the real x402/facilitator settle() shape: it calls
    // writeContract() then waitForTransactionReceipt() on the client we pass
    // in, and only returns the hash to us on success. On a post-broadcast
    // timeout the hash never reaches our return value — it must be captured
    // by intercepting the client's waitForTransactionReceipt call instead
    //.
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    const BROADCAST_TX_HASH = `0x${'ab'.repeat(32)}` as const;
    settleMock.mockImplementationOnce(
      async (client: {
        waitForTransactionReceipt: (args: { hash: string }) => Promise<unknown>;
      }) => {
        // Fire-and-forget, like the real SDK does — never awaited before the
        // timeout throw, and the unreachable RPC call is swallowed so it
        // can't make this test flaky.
        void client.waitForTransactionReceipt({ hash: BROADCAST_TX_HASH }).catch(() => {});
        throw new Error('The transaction may not be processed on a block yet - timed out');
      },
    );

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
        verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isCommerceError(err) &&
        err.code === 'PAYMENT_PROVIDER_UNAVAILABLE' &&
        err.details?.['transactionHash'] === BROADCAST_TX_HASH,
    );
  });

  it('settle() omits transactionHash from PAYMENT_PROVIDER_UNAVAILABLE when the broadcast itself never happened', async () => {
    // Contrast case: the RPC was unreachable before any writeContract call,
    // so waitForTransactionReceipt was never invoked and there is no hash to
    // report. A fabricated hash here would be worse than none.
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:19321'));

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
        verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isCommerceError(err) &&
        err.code === 'PAYMENT_PROVIDER_UNAVAILABLE' &&
        err.details === undefined,
    );
  });

  it('settle() throws PAYMENT_INVALID when the decoded submission is not an exact/EVM payload', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: 'not-decodable' },
        verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
      }),
    ).rejects.toSatisfy((err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_INVALID');
  });
});

describe('provider — provider-unavailable classification against real viem error types', () => {
  // Regression coverage for the fact that classifying
  // provider-unavailability by substring-matching error *messages* is
  // brittle across viem/undici upgrades. These construct the actual error
  // classes the pinned viem@2.55.18 HTTP transport (and
  // waitForTransactionReceipt) throw, rather than a hand-made
  // `Error("timed out")` whose shape has no guaranteed relationship to what
  // viem really produces.
  beforeEach(() => {
    verifyMock.mockReset();
    settleMock.mockReset();
  });

  function makeProvider() {
    return createX402PaymentProvider({
      network: 'base-sepolia',
      rpcUrl: RPC_URL,
      asset: ASSET,
      assetName: 'MockUSDC',
      assetVersion: '2',
      assetDecimals: 6,
      payTo: PAY_TO,
      facilitator: { mode: 'local', signerPrivateKey: BUYER_PRIVATE_KEY },
    });
  }

  it.each([
    ['TimeoutError (fetch-level timeout)', () => new TimeoutError({ body: {}, url: RPC_URL })],
    [
      'HttpRequestError (wraps ECONNREFUSED and other fetch failures)',
      () => new HttpRequestError({ url: RPC_URL, body: {}, cause: new Error('ECONNREFUSED') }),
    ],
    [
      'WaitForTransactionReceiptTimeoutError (settle() broadcast, then the receipt poll gave up)',
      () => new WaitForTransactionReceiptTimeoutError({ hash: `0x${'ab'.repeat(32)}` }),
    ],
  ])('verify() throws PAYMENT_PROVIDER_UNAVAILABLE for a real %s', async (_label, makeError) => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    verifyMock.mockRejectedValueOnce(makeError());

    await expect(
      provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });

  it.each([
    ['TimeoutError (fetch-level timeout)', () => new TimeoutError({ body: {}, url: RPC_URL })],
    [
      'HttpRequestError (wraps ECONNREFUSED and other fetch failures)',
      () => new HttpRequestError({ url: RPC_URL, body: {}, cause: new Error('ECONNREFUSED') }),
    ],
    [
      'WaitForTransactionReceiptTimeoutError (settle() broadcast, then the receipt poll gave up)',
      () => new WaitForTransactionReceiptTimeoutError({ hash: `0x${'ab'.repeat(32)}` }),
    ],
  ])('settle() throws PAYMENT_PROVIDER_UNAVAILABLE for a real %s', async (_label, makeError) => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockRejectedValueOnce(makeError());

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
        verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });
});
