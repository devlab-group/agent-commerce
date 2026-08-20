/**
 * Deterministic end-to-end x402 settlement suite.
 *
 * Boots a real, ephemeral local Anvil chain, deploys a real MockUSDC
 * contract, and drives the real `createX402PaymentProvider` through
 * `verify()`/`settle()` against it. Every assertion here is about *actual*
 * on-chain state — ERC-20 balance deltas and real transaction receipts —
 * never a mocked or console-only "payment successful".
 *
 * Never touches a public RPC or public chain: the chain is spawned by this
 * file and torn down in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CommerceResource,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
} from '../../../src/core/index.js';
import { isCommerceError } from '../../../src/core/index.js';
import { createPaymentProof, createX402PaymentProvider } from '../../../src/payments/x402/index.js';
import {
  type AnvilHandle,
  deployLocalChain,
  startAnvil,
} from '../../../src/payments/x402/testing.js';
import {
  assertBalanceDelta,
  expectRealSettlement,
  readBalances,
} from '../../fixtures/x402/settlement.js';

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

/** Builds a requirement + a validly-signed proof for it in one step. */
async function buildValidProof(
  amount: string,
  overrides?: Parameters<typeof createPaymentProof>[0]['overrides'],
): Promise<{ requirement: PaymentRequirement; proof: string }> {
  const requirement = await provider.createRequirement(paymentContext({ amount }));
  const proof = await createPaymentProof({
    buyerPrivateKey: deployment.buyer.privateKey,
    rpcUrl: anvil.rpcUrl,
    accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    ...(overrides !== undefined ? { overrides } : {}),
  });
  return { requirement, proof };
}

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  provider = createX402PaymentProvider({
    network: 'base-sepolia',
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

describe('x402 settlement — real local chain', () => {
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

  it('4. wrong amount (value below the required amount) is rejected before settlement', async () => {
    const before = await balances();
    const { requirement, proof } = await buildValidProof('1.00', { value: '1' }); // far below 1,000,000
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
  });

  it('5. wrong recipient is rejected before settlement', async () => {
    const before = await balances();
    const { requirement, proof } = await buildValidProof('1.00', {
      payTo: deployment.buyer.address, // a real, valid address — just not the merchant
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
    decoded.network = 'base';
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

  it('7. wrong asset (a real, but different, deployed token) is rejected before settlement', async () => {
    // Deploy a second, independent MockUSDC instance on the same live chain.
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
    const after = await balances();
    expect(after).toEqual(before);
  });

  it('8. replay: the same authorisation settled twice fails on chain the second time; replayKey is stable; merchant balance increases only once', async () => {
    const { requirement, proof } = await buildValidProof('2.00');
    const before = await balances();

    const verify1 = await provider.verify({
      requestId: 'req-replay-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(verify1.status).toBe('verified');

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

    // Replay: same authorisation, presented against a *different* request id.
    const verify2 = await provider.verify({
      requestId: 'req-replay-2',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    // The x402 SDK's verify() does not itself track used nonces —
    // this is exactly why the gateway reserves replayKey before settling.
    expect(verify2.status).toBe('verified');
    expect(verify2.replayKey).toBeDefined();
    expect(verify2.replayKey).toBe(verify1.replayKey);

    const settle2 = await provider.settle({
      requestId: 'req-replay-2',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
      verification: verify2,
    });
    // The authorisation's nonce is already used on chain — settlement must fail.
    expect(settle2.status).toBe('rejected');

    const afterSecond = await balances();
    // Merchant balance must NOT have increased a second time.
    expect(afterSecond.merchant).toBe(afterFirst.merchant);
    expect(afterSecond.buyer).toBe(afterFirst.buyer);
  });

  it('9. an expired authorisation (validBefore in the past) is rejected before settlement', async () => {
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

  it('10. provider failure: RPC unreachable yields PAYMENT_PROVIDER_UNAVAILABLE, not a silent pass', async () => {
    const unavailableProvider = createX402PaymentProvider({
      network: 'base-sepolia',
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
      rpcUrl: anvil.rpcUrl,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    await expect(
      unavailableProvider.verify({
        requestId: requirement.requestId,
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );

    const health = await unavailableProvider.health();
    expect(health.status).toBe('fail');
  });

  it('11. health() passes against the real local chain, confirming the anvil_nodeInfo probe works against a genuine Anvil node', async () => {
    const health = await provider.health();
    expect(health.status).toBe('pass');
    expect(health.detail).toContain('Anvil');
  });
});
