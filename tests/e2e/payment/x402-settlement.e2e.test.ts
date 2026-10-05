/**
 * End-to-end x402 settlement against an ephemeral Anvil this file spawns and
 * tears down, with a real MockUSDC and the real `createX402PaymentProvider`.
 * Settlement assertions read on-chain state: ERC-20 balance deltas and
 * transaction receipts. No public RPC or chain is touched.
 *
 * Most refused proofs go through a gateway built from parsed config, where the
 * unaltered proof settles (test 1b). An unchanged balance there shows that the
 * refusal stopped a payment that would otherwise have moved funds.
 */

import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import {
  type BackendExecutor,
  type CommerceResource,
  isCommerceError,
  NOOP_LOGGER,
  PAYMENT_HEADER,
  type PaymentContext,
  type PaymentProvider,
  type PaymentRequirement,
  type ReceiptStore,
} from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createPaymentProof, createX402PaymentProvider } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createA2aAdapter } from '../../../src/protocols/a2a';
import type { A2aTask } from '../../../src/protocols/a2a/types';
import { A2A_X402_EXTENSION_URI } from '../../../src/protocols/a2a/x402-extension';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { startLossyRpc, unreachableRpcUrl } from '../../fixtures/x402/lossy-rpc';
import {
  assertBalanceDelta,
  expectRealSettlement,
  readBalances,
} from '../../fixtures/x402/settlement';

const PORT = 18790;
const RESOURCE_ID = 'market_report';
// The same resource under the `upfront` flow, which settles before the backend
const UPFRONT_RESOURCE_ID = 'market_report_upfront';

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
let gateway: GatewayInstance;
let store: ReceiptStore;
let backendCalls = 0;
let backendFails = false;

const backend: BackendExecutor = {
  async call() {
    backendCalls += 1;
    if (backendFails) throw new Error('merchant backend down');
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

async function startGateway(): Promise<void> {
  const config = parseConfig(
    {
      version: 1,
      merchant: { id: 'x402-e2e', name: 'x402 E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
      server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: {
        http: { enabled: true },
        mcp: { enabled: false, mountPath: '/mcp' },
        a2a: { enabled: true, mountPath: '/a2a' },
      },
      resources: {
        [RESOURCE_ID]: {
          name: 'Market report',
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
          pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
          expose: ['http', 'a2a'],
          payments: ['x402'],
        },
        [UPFRONT_RESOURCE_ID]: {
          name: 'Market report, paid upfront',
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
          pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
          paymentFlow: 'upfront',
        },
      },
      payments: {
        x402: {
          enabled: true,
          network: 'eip155:84532',
          rpcUrl: anvil.rpcUrl,
          asset: deployment.asset,
          assetName: deployment.assetName,
          assetVersion: deployment.assetVersion,
          assetDecimals: deployment.assetDecimals,
          payTo: deployment.merchant.address,
          maxTimeoutSeconds: 120,
          facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
        },
      },
    },
    {},
  );
  store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  gateway = await createGateway({
    config,
    store,
    paymentProviders: createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [createA2aAdapter()],
    backend,
  });
}

interface Invocation {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: Record<string, unknown>;
}

async function invoke(
  headers: Record<string, string> = {},
  resourceId = RESOURCE_ID,
): Promise<Invocation> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${resourceId}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
  return { statusCode: res.statusCode, headers: res.headers, body: res.json() };
}

// Asks the gateway for the resource unpaid and signs the challenge it returns
async function gatewayProof(
  overrides?: Parameters<typeof createPaymentProof>[0]['overrides'],
  resourceId = RESOURCE_ID,
): Promise<string> {
  const challenged = await invoke({}, resourceId);
  expect(challenged.statusCode).toBe(402);
  const payment = challenged.body['payment'] as { accepts: Record<string, unknown>[] };
  return createPaymentProof({
    buyerPrivateKey: deployment.buyer.privateKey,
    accepts: payment.accepts[0] as Record<string, unknown>,
    ...(overrides !== undefined ? { overrides } : {}),
  });
}

interface MutableProof {
  accepted: Record<string, unknown>;
  payload: { signature: string; authorization: Record<string, string> };
}

// Re-encodes a proof with one part changed and nothing re-signed
function altered(proof: string, change: (decoded: MutableProof) => void): string {
  const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf8')) as MutableProof;
  change(decoded);
  return Buffer.from(JSON.stringify(decoded)).toString('base64');
}

// A proof the gateway refuses: the named reason, no delivery, nothing moved
async function expectRefused(proof: string, reason: string): Promise<void> {
  const before = await balances();
  const callsBefore = backendCalls;

  const refused = await invoke({ [PAYMENT_HEADER]: proof });

  expect(refused.statusCode).toBe(402);
  expect(refused.body['code']).toBe('PAYMENT_INVALID');
  expect(refused.body['message']).toBe(reason);
  // The x402 client reads the refusal reason from the new challenge
  const header = (name: string) => refused.headers[name.toLowerCase()] as string | undefined;
  const challenge = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(header);
  expect(challenge.error).toBe(reason);
  expect(backendCalls).toBe(callsBefore);
  expect(await balances()).toEqual(before);
}

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
  await startGateway();
}, 120_000);

afterAll(async () => {
  await gateway?.close().catch(() => {});
  await store?.close().catch(() => {});
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

  it('1b. through the gateway, a valid proof settles once, delivers, and the receipt names the transaction', async () => {
    const proof = await gatewayProof();
    const before = await balances();
    const callsBefore = backendCalls;

    const paid = await invoke({ [PAYMENT_HEADER]: proof });

    expect(paid.statusCode).toBe(200);
    expect(backendCalls).toBe(callsBefore + 1);
    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment).toMatchObject({ provider: 'x402', status: 'settled' });
    // Check that the SDK client reads the base-unit amount and payer
    const header = (name: string) => paid.headers[name.toLowerCase()] as string | undefined;
    const settlement = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(header);
    expect(settlement).toMatchObject({
      success: true,
      transaction: receipt?.payment?.externalReference,
      amount: '1000000',
      payer: deployment.buyer.address,
    });
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await balances(),
      amountBaseUnits: 1_000_000n,
      txHash: receipt?.payment?.externalReference as string,
    });
  });

  it('2. no payment: the gateway answers 402 with a challenge and delivers nothing', async () => {
    const callsBefore = backendCalls;

    const challenged = await invoke();

    expect(challenged.statusCode).toBe(402);
    expect(challenged.body['code']).toBe('PAYMENT_REQUIRED');
    const payment = challenged.body['payment'] as { accepts: Record<string, unknown>[] };
    expect(payment.accepts[0]).toMatchObject({
      amount: '1000000',
      payTo: deployment.merchant.address,
      asset: deployment.asset,
    });
    expect(backendCalls).toBe(callsBefore);
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
      expect(result.rejectionReason).toBe('invalid_payload');
    }
  });

  it('3b. a signature or signed authorization field changed after signing is refused', async () => {
    const proof = await gatewayProof();
    const flipFirstDigit = (hex: string) => `0x${hex[2] === '0' ? '1' : '0'}${hex.slice(3)}`;
    const changes: ((decoded: MutableProof) => void)[] = [
      (d) => {
        d.payload.signature = flipFirstDigit(d.payload.signature);
      },
      (d) => {
        d.payload.authorization['nonce'] = `0x${'ab'.repeat(32)}`;
      },
      (d) => {
        d.payload.authorization['from'] = deployment.merchant.address;
      },
    ];
    for (const change of changes) {
      await expectRefused(altered(proof, change), 'invalid_exact_evm_signature');
    }
  });

  it.each(['999999', '1000001'])(
    '4. an authorized value other than the price is refused before settlement: %s',
    async (value) => {
      await expectRefused(
        await gatewayProof({ value }),
        'invalid_exact_evm_payload_authorization_value_mismatch',
      );
    },
  );

  it('5. a proof paying another recipient is refused before settlement', async () => {
    // A valid address, just not the merchant
    await expectRefused(
      await gatewayProof({ payTo: deployment.buyer.address }),
      'invalid_exact_evm_payload_recipient_mismatch',
    );
  });

  it('6. a proof for another network is refused before settlement', async () => {
    // v2 carries the network on the accepted requirement, not at the top level
    const proof = altered(await gatewayProof(), (d) => {
      d.accepted['network'] = 'eip155:8453';
    });
    await expectRefused(proof, 'invalid_network');
  });

  it('7. another deployed token is refused in the requirement or the buyer proof', async () => {
    // A second, independent MockUSDC on the same chain, which funds the buyer
    const otherToken = await deployLocalChain({
      rpcUrl: anvil.rpcUrl,
      buyerInitialBalance: '10.00',
    });
    expect(otherToken.asset).not.toBe(deployment.asset);

    // The provider builds the requirement, so only a corrupted one can name
    // another token. That never reaches the gateway's HTTP surface.
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

    const challenged = await invoke();
    const offered = (challenged.body['payment'] as { accepts: Record<string, unknown>[] })
      .accepts[0];
    const proofForOtherAsset = await createPaymentProof({
      buyerPrivateKey: deployment.buyer.privateKey,
      accepts: { ...offered, asset: otherToken.asset },
    });
    await expectRefused(proofForOtherAsset, 'invalid_exact_evm_signature');
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
    // The SDK's transfer simulation reverts on the spent nonce
    expect(verifyAfterSettling.rejectionReason).toBe(
      'invalid_exact_evm_transaction_simulation_failed',
    );

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

  it('9. an expired authorization (validBefore in the past) is refused before settlement', async () => {
    const proof = await gatewayProof({ validBefore: Math.floor(Date.now() / 1000) - 60 });
    await expectRefused(proof, 'invalid_exact_evm_payload_authorization_valid_before');
  });

  it('9b. an authorization that is not yet valid (validAfter in the future) is refused before settlement', async () => {
    // The mirror image of test 9: EIP-3009 bounds an authorization at both
    // ends, and `MockUSDC` and the SDK (`ErrValidAfterInFuture`) enforce both
    const proof = await gatewayProof({ validAfter: Math.floor(Date.now() / 1000) + 3600 });
    await expectRefused(proof, 'invalid_exact_evm_payload_authorization_valid_after');
  });

  it('10. provider failure: RPC unreachable yields PAYMENT_PROVIDER_UNAVAILABLE, not a silent pass', async () => {
    const unavailableProvider = createX402PaymentProvider({
      network: 'eip155:84532',
      rpcUrl: await unreachableRpcUrl(),
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

  it('13. reports a settled upfront payment after backend failure', async () => {
    const proof = await gatewayProof(undefined, UPFRONT_RESOURCE_ID);
    const before = await balances();

    backendFails = true;
    let failed: Invocation;
    try {
      failed = await invoke({ [PAYMENT_HEADER]: proof }, UPFRONT_RESOURCE_ID);
    } finally {
      backendFails = false;
    }

    expect(failed.body['code']).toBe('BACKEND_ERROR');
    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.metadata).toMatchObject({ delivered: false });
    expect(receipt?.payment).toMatchObject({ provider: 'x402', status: 'settled' });
    const txHash = receipt?.payment?.externalReference as string;
    const summary = JSON.parse(
      Buffer.from(String(failed.headers['payment-response']), 'base64').toString('utf8'),
    );
    expect(summary).toMatchObject({ success: true, transaction: txHash });
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await balances(),
      amountBaseUnits: 1_000_000n,
      txHash,
    });
  });

  it('14. settles an A2A x402 payment on the local chain', async () => {
    async function sendMessage(message: Record<string, unknown>): Promise<A2aTask> {
      const res = await gateway.server.inject({
        method: 'POST',
        url: '/a2a',
        headers: {
          'content-type': 'application/json',
          'a2a-version': '1.0',
          'a2a-extensions': A2A_X402_EXTENSION_URI,
        },
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message },
        }),
      });
      return res.json<{ result: { task: A2aTask } }>().result.task;
    }
    const callsBefore = backendCalls;

    const waiting = await sendMessage({
      role: 'ROLE_USER',
      messageId: 'msg-buy',
      parts: [{ data: { resource: RESOURCE_ID }, mediaType: 'application/json' }],
    });
    expect(waiting.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(backendCalls).toBe(callsBefore);

    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(deployment.buyer.privateKey),
      networks: ['eip155:84532'],
    });
    client.setSpendControls(false); // MockUSDC is not in the SDK's asset list
    const payload = await client.createPaymentPayload(
      waiting.status.message?.metadata?.['x402.payment.required'] as PaymentRequired,
    );

    const before = await balances();
    const paid = await sendMessage({
      role: 'ROLE_USER',
      messageId: 'msg-pay',
      taskId: waiting.id,
      contextId: waiting.contextId,
      parts: [{ text: 'Here is the payment authorization.' }],
      metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': payload },
    });
    const after = await balances();

    expect(paid.status.state).toBe('TASK_STATE_COMPLETED');
    const [receipt] = (paid.status.message?.metadata?.['x402.payment.receipts'] ?? []) as {
      success: boolean;
      transaction: string;
    }[];
    expect(receipt?.success).toBe(true);
    expect(backendCalls).toBe(callsBefore + 1);
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after,
      amountBaseUnits: 1_000_000n,
      txHash: receipt?.transaction as string,
    });
  });

  it('15. leaves funds untouched when the backend fails before settlement', async () => {
    const proof = await gatewayProof();
    const receiptsBefore = (await store.listReceipts()).length;
    const before = await balances();

    backendFails = true;
    let failed: Invocation;
    try {
      failed = await invoke({ [PAYMENT_HEADER]: proof });
    } finally {
      backendFails = false;
    }

    expect(failed.body['code']).toBe('BACKEND_ERROR');
    expect(failed.headers['payment-response']).toBeUndefined();
    const after = await balances();
    expect(after.buyer).toBe(before.buyer);
    expect(after.merchant).toBe(before.merchant);
    expect(await store.listReceipts()).toHaveLength(receiptsBefore);
  });
});
