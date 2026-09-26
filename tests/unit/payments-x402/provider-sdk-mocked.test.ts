/**
 * The branches of provider.ts that depend on what the SDK facilitator returns
 * or throws: success, rejection with and without a reason, and thrown errors of
 * several shapes. Mocked at the SDK boundary; tests/e2e/payment covers real
 * on-chain settlement.
 */

import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceResource, PaymentContext } from '../../../src/core';
import { isCommerceError } from '../../../src/core';
import { createPaymentProof } from '../../../src/payments/x402/client';
import { createX402PaymentProvider } from '../../../src/payments/x402/provider';

const verifyMock = vi.fn();
const settleMock = vi.fn();

// The mocked facilitator answers verify() and settle() itself, so scheme
// registration is a no-op
vi.mock('@x402/core/facilitator', () => ({
  x402Facilitator: class {
    verify(...args: unknown[]) {
      return verifyMock(...args);
    }
    settle(...args: unknown[]) {
      return settleMock(...args);
    }
  },
}));

vi.mock('@x402/evm/exact/facilitator', () => ({
  registerExactEvmScheme: (facilitator: unknown) => facilitator,
}));

const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const RPC_URL = 'http://127.0.0.1:19321'; // never contacted: verify and settle are mocked

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

describe('provider - SDK-boundary branches (mocked x402/facilitator)', () => {
  beforeEach(() => {
    verifyMock.mockReset();
    settleMock.mockReset();
  });

  function makeProvider() {
    return createX402PaymentProvider({
      network: 'eip155:84532',
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
    // v2 keeps the description on the envelope's `resource`, not on the
    // requirement
    const envelope = requirement.challenge.envelope as { resource: Record<string, unknown> };
    expect(envelope.resource['description']).toBe(RESOURCE.name);
  });

  it('rejects at construction time for a non-integer or negative assetDecimals', async () => {
    expect(() => createX402PaymentProvider({ ...baseOptions(), assetDecimals: -1 })).toThrow();
    expect(() => createX402PaymentProvider({ ...baseOptions(), assetDecimals: 1.5 })).toThrow();

    function baseOptions() {
      return {
        network: 'eip155:84532',
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

  it.each([
    ['unsupported characters', 'do not expose: secret', 'invalid_payment'],
    ['more than 64 characters', 'x'.repeat(65), 'invalid_payment'],
    ['an empty value', '', 'invalid_payment'],
    ['only whitespace', '   ', 'invalid_payment'],
    ['surrounding whitespace', '  insufficient_funds  ', 'insufficient_funds'],
  ])('verify() normalizes a facilitator reason with %s', async (_case, invalidReason, expected) => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    verifyMock.mockResolvedValueOnce({ isValid: false, invalidReason });

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe(expected);
  });

  it('verify() throws PAYMENT_PROVIDER_UNAVAILABLE when the SDK throws a non-connection error', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    verifyMock.mockRejectedValueOnce(new TypeError('something exploded'));

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

  it('verify() throws PAYMENT_PROVIDER_UNAVAILABLE when the SDK throws a connection-shaped error', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
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
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockResolvedValueOnce({
      success: true,
      transaction: '0xdeadbeef',
      network: 'eip155:84532',
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
        network: 'eip155:84532',
        asset: ASSET,
        replayKey: '0xabc',
      },
    });
    expect(result.status).toBe('settled');
    expect(result.externalReference).toBe('0xdeadbeef');
    expect(result.payee).toBe(PAY_TO);
    expect(result.network).toBe('eip155:84532');
    expect(result.asset).toBe(ASSET);
    expect(result.replayKey).toBe('0xabc');
    expect(result.settledAt).toBeDefined();
  });

  it('settle() omits payer when the SDK success response does not include one', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockResolvedValueOnce({
      success: true,
      transaction: '0xfeedface',
      network: 'eip155:84532',
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
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    settleMock.mockResolvedValueOnce({
      success: false,
      network: 'eip155:84532',
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

    settleMock.mockResolvedValueOnce({ success: false, network: 'eip155:84532' });
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

  it.each([
    ['unsupported characters', 'do not expose: secret', 'settlement_failed'],
    ['more than 64 characters', 'x'.repeat(65), 'settlement_failed'],
    ['an empty value', '', 'settlement_failed'],
    ['only whitespace', '   ', 'settlement_failed'],
    ['surrounding whitespace', '  insufficient_funds  ', 'insufficient_funds'],
  ])('settle() normalizes a facilitator reason with %s', async (_case, errorReason, expected) => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    settleMock.mockResolvedValueOnce({
      success: false,
      network: 'eip155:84532',
      errorReason,
    });

    const result = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe(expected);
  });

  it('settle() rejects an on-chain revert but reports an unclassified throw as unavailable', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
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
        network: 'eip155:84532',
        asset: ASSET,
        replayKey: '0xreverted',
      },
    });
    expect(reverted.status).toBe('rejected');
    expect(reverted.rejectionReason).toBe('transaction_reverted');
    expect(reverted.network).toBe('eip155:84532');
    expect(reverted.asset).toBe(ASSET);
    expect(reverted.replayKey).toBe('0xreverted');

    // viem's wrapper around a revert is still a revert
    settleMock.mockRejectedValueOnce(
      new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: [], functionName: 'transferWithAuthorization' }),
        { abi: [], functionName: 'transferWithAuthorization' },
      ),
    );
    const wrapped = await provider.settle({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
    });
    expect(wrapped.rejectionReason).toBe('transaction_reverted');

    // An unclassified throw leaves the broadcast unknown, so it must come back
    // as an unavailable provider, never a rejection. The same wrapper around an
    // RPC error is one of those.
    for (const thrown of [
      new TypeError('boom'),
      new ContractFunctionExecutionError(new BaseError('nonce too low'), {
        abi: [],
        functionName: 'transferWithAuthorization',
      }),
    ]) {
      settleMock.mockRejectedValueOnce(thrown);
      await expect(
        provider.settle({
          requestId: 'req-1',
          resource: RESOURCE,
          requirement,
          submission: { method: 'x402', payload: proof },
          verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isCommerceError(error) && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
      );
    }
  });

  it('settle() throws PAYMENT_PROVIDER_UNAVAILABLE when the SDK throws a connection-shaped error', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
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

  it.each([
    ['without a hash, as an unknown outcome', '', 'throws'],
    ['with a value that is not a hash, as an unknown outcome', 'not-a-hash', 'throws'],
    ['with a hash, as a mined revert', `0x${'cd'.repeat(32)}`, 'rejected'],
  ])(
    'settle() treats the SDK catch-all transaction failure %s',
    async (_label, transaction, outcome) => {
      const provider = makeProvider();
      const requirement = await provider.createRequirement(paymentContext());
      const proof = await createPaymentProof({
        buyerPrivateKey: BUYER_PRIVATE_KEY,
        accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
      });
      settleMock.mockResolvedValueOnce({
        success: false,
        errorReason: 'invalid_exact_evm_transaction_failed',
        transaction,
        network: 'eip155:84532',
      });

      const settled = provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
        verification: { status: 'verified', provider: 'x402', amount: '0.01', currency: 'USD' },
      });

      if (outcome === 'throws') {
        await expect(settled).rejects.toSatisfy(
          (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
        );
      } else {
        await expect(settled).resolves.toMatchObject({ status: 'rejected' });
      }
    },
  );

  it('settle() attaches transactionHash to PAYMENT_PROVIDER_UNAVAILABLE when the broadcast succeeded but confirmation timed out', async () => {
    // `settlement_pending` means the transfer was broadcast and may be on-chain,
    // so it becomes an unavailable provider carrying the hash, never a
    // rejection
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    const BROADCAST_TX_HASH = `0x${'ab'.repeat(32)}` as const;
    settleMock.mockResolvedValueOnce({
      success: false,
      errorReason: 'settlement_pending',
      transaction: BROADCAST_TX_HASH,
      network: 'eip155:84532',
      payer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });

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
    // The RPC failed before any broadcast, so there is no hash to report and
    // none may be invented
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
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

describe('provider - provider-unavailable classification against real viem error types', () => {
  // Uses the error classes the pinned viem HTTP transport and
  // waitForTransactionReceipt throw, not a hand-made
  // `Error("timed out")`, because message matching breaks across upgrades
  beforeEach(() => {
    verifyMock.mockReset();
    settleMock.mockReset();
  });

  function makeProvider() {
    return createX402PaymentProvider({
      network: 'eip155:84532',
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
