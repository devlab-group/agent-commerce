/**
 * End-to-end x402 settlement against an ephemeral Anvil this file spawns and
 * tears down, with a real MockUSDC and the real `createX402PaymentProvider`.
 * Settlement assertions read on-chain state: ERC-20 balance deltas and
 * transaction receipts. No public RPC or chain is touched.
 */

import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CommerceResource,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
} from '../../../src/core';
import { isCommerceError } from '../../../src/core';
import { createPaymentProof, createX402PaymentProvider } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { startLossyRpc } from '../../fixtures/x402/lossy-rpc';
import {
  assertBalanceDelta,
  expectRealSettlement,
  readBalances,
} from '../../fixtures/x402/settlement';

const PORT = 18790;

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  description: 'A paid demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '1.00', currency: 'USD' },
  exposedVia: ['http'],
  paymentMethods: ['x402'],
};

function paymentContext(overrides: Partial<PaymentContext> = {}): PaymentContext {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    resource: RESOURCE,
    amount: '1.00',
    currency: 'USD',
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let provider: PaymentProvider;

async function balances() {
  return readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: deployment.merchant.address,
  });
}

// Builds a requirement and a validly signed proof for it
async function buildValidProof(
  amount: string,
  overrides?: Parameters<typeof createPaymentProof>[0]['overrides'],
): Promise<{ requirement: PaymentRequirement; proof: string }> {
  const requirement = await provider.createRequirement(paymentContext({ amount }));
  const proof = await createPaymentProof({
    buyerPrivateKey: deployment.buyer.privateKey,
    accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    ...(overrides !== undefined ? { overrides } : {}),
  });
  return { requirement, proof };
}

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  provider = createX402PaymentProvider({
    network: 'eip155:84532',
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    assetName: deployment.assetName,
    assetVersion: deployment.assetVersion,
    assetDecimals: deployment.assetDecimals,
    payTo: deployment.merchant.address,
    facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
  });
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
});

describe('x402 settlement - real local chain', () => {
  it('1. valid payment: buyer balance decreases, merchant balance increases, real tx on chain', async () => {
    const { requirement, proof } = await buildValidProof('1.00');
    const before = await balances();

    const verifyResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyResult.status).toBe('verified');

    const settleResult = await provider.settle({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: verifyResult,
    });
    expect(settleResult.status).toBe('settled');
    expect(settleResult.externalReference).toBeDefined();

    const after = await balances();
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after,
      amountBaseUnits: 1_000_000n, // 1.00 at 6 decimals
      txHash: settleResult.externalReference as string,
    });
  });

  it('2. missing payment proof is rejected, not delivered', async () => {
    const requirement = await provider.createRequirement(paymentContext());
    const result = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: '' },
    });
    expect(result.status).toBe('rejected');
  });

  it('3. malformed proof is rejected in every variant, never thrown', async () => {
    const requirement = await provider.createRequirement(paymentContext());
    const variants = [
      'this-is-not-base64-or-json!!!', // not base64/JSON at all
      Buffer.from('{{{not valid json').toString('base64'), // valid base64, invalid JSON
      Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64'), // valid JSON, wrong schema
    ];
    for (const payload of variants) {
      const result = await provider.verify({
        requestId: requirement.requestId,
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload },
      });
      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('malformed_payment_payload');
    }
  });

  it('3b. a signature or signed authorization field changed after signing is rejected', async () => {
    const before = await balances();
    const { requirement, proof } = await buildValidProof('1.00');
    const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    const signature = decoded.payload.signature as string;
    const tampered = [
      {
        ...decoded,
        payload: {
          ...decoded.payload,
          signature: `${signature.slice(0, 2)}${signature[2] === '0' ? '1' : '0'}${signature.slice(3)}`,
        },
      },
      {
        ...decoded,
        payload: {
          ...decoded.payload,
          authorization: { ...decoded.payload.authorization, nonce: `0x${'ab'.repeat(32)}` },
        },
      },
      {
        ...decoded,
        payload: {
          ...decoded.payload,
          authorization: {
            ...decoded.payload.authorization,
            from: deployment.merchant.address,
          },
        },
      },
    ];

    for (const changed of tampered) {
      const verifyResult = await provider.verify({
        requestId: requirement.requestId,
        resource: RESOURCE,
        requirement,
        submission: {
          method: 'x402',
          payload: Buffer.from(JSON.stringify(changed)).toString('base64'),
        },
      });
      expect(verifyResult.status).toBe('rejected');
    }
    const after = await balances();
    expect(after).toEqual(before);
  });

  it.each(['1', '1000001'])(
    '4. an amount below or above the required amount is rejected before settlement: %s',
    async (value) => {
      const before = await balances();
      const { requirement, proof } = await buildValidProof('1.00', { value });
      const verifyResult = await provider.verify({
        requestId: requirement.requestId,
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
      });
      expect(verifyResult.status).toBe('rejected');
      expect(verifyResult.rejectionReason).toBe('wrong_amount');
      const after = await balances();
      expect(after).toEqual(before);
    },
  );

  it('5. wrong recipient is rejected before settlement', async () => {
    const before = await balances();
    const { requirement, proof } = await buildValidProof('1.00', {
      payTo: deployment.buyer.address, // a valid address, just not the merchant
    });
    const verifyResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyResult.status).toBe('rejected');
    expect(verifyResult.rejectionReason).toBe('wrong_recipient');
    const after = await balances();
    expect(after).toEqual(before);
  });

  it('6. wrong network is rejected before settlement', async () => {
    const before = await balances();
    const { requirement, proof } = await buildValidProof('1.00');
    const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    // v2 carries the network on the accepted requirement, not at the top level
    decoded.accepted.network = 'eip155:8453';
    const tamperedProof = Buffer.from(JSON.stringify(decoded)).toString('base64');

    const verifyResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: tamperedProof },
    });
    expect(verifyResult.status).toBe('rejected');
    expect(verifyResult.rejectionReason).toBe('wrong_network');
    const after = await balances();
    expect(after).toEqual(before);
  });

  it('7. another deployed token is rejected in the requirement or buyer proof', async () => {
    // A second, independent MockUSDC on the same chain
    const otherToken = await deployLocalChain({
      rpcUrl: anvil.rpcUrl,
      buyerInitialBalance: '10.00',
    });
    expect(otherToken.asset).not.toBe(deployment.asset);

    const before = await balances();
    const { requirement, proof } = await buildValidProof('1.00');
    const accepted = requirement.challenge.accepts[0] as Record<string, unknown>;
    const tamperedRequirement: PaymentRequirement = {
      ...requirement,
      challenge: {
        ...requirement.challenge,
        accepts: [{ ...accepted, asset: otherToken.asset }],
      },
    };

    const verifyResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement: tamperedRequirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyResult.status).toBe('rejected');
    expect(verifyResult.rejectionReason).toBe('wrong_asset');

    const proofForOtherAsset = await createPaymentProof({
      buyerPrivateKey: deployment.buyer.privateKey,
      accepts: { ...accepted, asset: otherToken.asset },
    });
    const buyerProofResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proofForOtherAsset },
    });
    expect(buyerProofResult.status).toBe('rejected');
    expect(buyerProofResult.rejectionReason).toBe('invalid_exact_evm_signature');

    const after = await balances();
    expect(after).toEqual(before);
  });

  it('8. replay: replayKey is stable across presentations, the second settlement moves no funds', async () => {
    const { requirement, proof } = await buildValidProof('2.00');
    const before = await balances();

    const verify1 = await provider.verify({
      requestId: 'req-replay-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verify1.status).toBe('verified');

    // The same authorization on a different request id before anything has
    // settled: nothing on chain can stop it yet, so only the gateway's
    // reservation can
    const verifyAgainBeforeSettling = await provider.verify({
      requestId: 'req-replay-2',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyAgainBeforeSettling.status).toBe('verified');
    expect(verifyAgainBeforeSettling.replayKey).toBeDefined();
    expect(verifyAgainBeforeSettling.replayKey).toBe(verify1.replayKey);

    const settle1 = await provider.settle({
      requestId: 'req-replay-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: verify1,
    });
    expect(settle1.status).toBe('settled');

    const afterFirst = await balances();
    assertBalanceDelta(before, afterFirst, 2_000_000n);

    // Once the nonce is spent on chain, verify() catches the replay too. That
    // check exists only after settlement, which is why the gateway reserves
    // the replay key before settling.
    const verifyAfterSettling = await provider.verify({
      requestId: 'req-replay-3',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyAfterSettling.status).toBe('rejected');

    // Settling the spent authorization anyway moves nothing. MockUSDC's custom
    // revert is not in the SDK's ABI, so the SDK reports its catch-all, which
    // the provider must treat as an unknown outcome.
    const settle2 = provider.settle({
      requestId: 'req-replay-2',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: verifyAgainBeforeSettling,
    });
    await expect(settle2).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );

    const afterSecond = await balances();
    // The merchant balance must not increase a second time
    expect(afterSecond.merchant).toBe(afterFirst.merchant);
    expect(afterSecond.buyer).toBe(afterFirst.buyer);
  });

  it('9. an expired authorization (validBefore in the past) is rejected before settlement', async () => {
    const before = await balances();
    const expiredValidBefore = Math.floor(Date.now() / 1000) - 60;
    const { requirement, proof } = await buildValidProof('1.00', {
      validBefore: expiredValidBefore,
    });

    const verifyResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyResult.status).toBe('rejected');
    const after = await balances();
    expect(after).toEqual(before);
  });

  it('9b. an authorization that is not yet valid (validAfter in the future) is rejected before settlement', async () => {
    // The mirror image of test 9: EIP-3009 bounds an authorization at both
    // ends, and `MockUSDC` and the SDK (`ErrValidAfterInFuture`) enforce both
    const before = await balances();
    const notYetValid = Math.floor(Date.now() / 1000) + 3600;
    const { requirement, proof } = await buildValidProof('1.00', { validAfter: notYetValid });

    const verifyResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyResult.status).toBe('rejected');
    const after = await balances();
    expect(after).toEqual(before);
  });

  it('10. provider failure: RPC unreachable yields PAYMENT_PROVIDER_UNAVAILABLE, not a silent pass', async () => {
    const unavailableProvider = createX402PaymentProvider({
      network: 'eip155:84532',
      rpcUrl: 'http://127.0.0.1:18791', // nothing listening here
      asset: deployment.asset,
      assetName: deployment.assetName,
      assetVersion: deployment.assetVersion,
      assetDecimals: deployment.assetDecimals,
      payTo: deployment.merchant.address,
      facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
    });

    const requirement = await unavailableProvider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: deployment.buyer.privateKey,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    await expect(
      unavailableProvider.verify({
        requestId: requirement.requestId,
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        isCommerceError(err) &&
        err.code === 'PAYMENT_PROVIDER_UNAVAILABLE' &&
        err.details === undefined
      );
    });

    const health = await unavailableProvider.health();
    expect(health.status).toBe('fail');
  });

  it('10b. a broadcast whose RPC response is an unclassified error is uncertain, never a rejection', async () => {
    const rpc = await startLossyRpc(anvil.rpcUrl);
    try {
      const lossyProvider = createX402PaymentProvider({
        network: 'eip155:84532',
        rpcUrl: rpc.url,
        asset: deployment.asset,
        assetName: deployment.assetName,
        assetVersion: deployment.assetVersion,
        assetDecimals: deployment.assetDecimals,
        payTo: deployment.merchant.address,
        facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
      });
      const requirement = await lossyProvider.createRequirement(paymentContext());
      const proof = await createPaymentProof({
        buyerPrivateKey: deployment.buyer.privateKey,
        accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
      });
      const submission = { method: 'x402' as const, payload: proof };
      const before = await balances();
      const verification = await lossyProvider.verify({
        requestId: requirement.requestId,
        resource: RESOURCE,
        requirement,
        submission,
      });
      expect(verification.status).toBe('verified');

      const settled = lossyProvider.settle({
        requestId: requirement.requestId,
        resource: RESOURCE,
        requirement,
        submission,
        verification,
      });

      // The transfer landed, so reporting "rejected" would release the
      // replay key and blame the buyer for a payment that went through
      await expect(settled).rejects.toSatisfy(
        (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
      );
      assertBalanceDelta(before, await balances(), 1_000_000n);
    } finally {
      await rpc.close();
    }
  });

  it('11. health() passes against the real local chain, confirming the anvil_nodeInfo probe works against a genuine Anvil node', async () => {
    const health = await provider.health();
    expect(health.status).toBe('pass');
    expect(health.detail).toContain('Anvil');
  });

  it('12. interop: a payment built by the x402 SDK client settles against this gateway', async () => {
    // Every other case signs with our own `createPaymentProof`, so our
    // challenge and verification could agree with each other and nothing else.
    // This one pays with the SDK's own client, as an off-the-shelf buyer would.
    const buyer = privateKeyToAccount(deployment.buyer.privateKey);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: buyer, networks: ['eip155:84532'] });
    // The SDK's default spend controls allow only assets it recognizes, and
    // MockUSDC is not one, so they are off for this local-only case. A real
    // buyer would allowlist its asset.
    client.setSpendControls(false);

    const requirement = await provider.createRequirement(paymentContext({ amount: '1.00' }));
    const challenge = requirement.challenge.envelope as unknown as PaymentRequired;
    const payload = await client.createPaymentPayload(challenge);
    const proof = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

    const before = await balances();
    const verifyResult = await provider.verify({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verifyResult.status).toBe('verified');

    const settleResult = await provider.settle({
      requestId: requirement.requestId,
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: verifyResult,
    });
    expect(settleResult.status).toBe('settled');

    const after = await balances();
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after,
      amountBaseUnits: 1_000_000n,
      txHash: settleResult.externalReference as string,
    });
  });
});
