/**
 * Settles MockUSDC on Anvil through canonical Permit2 and x402 exact proxy
 * code at their addresses, using the in-process facilitator. The buyer
 * approves Permit2; the gateway sends no approval.
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { createWalletClient, erc20Abi, http, maxUint256, publicActions } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil as anvilChain } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GatewayConfig, parseConfig } from '../../../src/config';
import { type BackendExecutor, isCommerceError, NOOP_LOGGER } from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createX402PaymentProvider } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { startLossyRpc } from '../../fixtures/x402/lossy-rpc';
import { installMulticall3, installPermit2 } from '../../fixtures/x402/permit2-contracts';
import {
  assertBalanceDelta,
  expectRealSettlement,
  readBalances,
} from '../../fixtures/x402/settlement';

const PORT = 18794;
const RESOURCE_ID = 'market_report';
const MERCHANT = privateKeyToAccount(generatePrivateKey()).address;

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let config: GatewayConfig;
let gateway: GatewayInstance;
let store: ReturnType<typeof createSqliteReceiptStore>;
let backendCalls = 0;

const backend: BackendExecutor = {
  async call() {
    backendCalls += 1;
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

const balances = () =>
  readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: MERCHANT,
  });

// A fresh provider has no cached health result
const freshHealth = async () =>
  (
    (await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER))[0] as {
      health(): Promise<{ status: string; detail?: string }>;
    }
  ).health();

async function invoke(headers: Record<string, string> = {}) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
}

type Permit2Proof = {
  payload: {
    permit2Authorization: { deadline: string; witness: { to: string } };
  };
};

async function signedProof(): Promise<Permit2Proof> {
  const unpaid = await invoke();
  expect(unpaid.statusCode).toBe(402);
  return sign(
    new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
      (name) => unpaid.headers[name.toLowerCase()] as string | undefined,
    ),
  );
}

async function sign(offered: PaymentRequired): Promise<Permit2Proof> {
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(deployment.buyer.privateKey),
    networks: ['eip155:31337'],
  });
  client.setSpendControls(false);
  return (await client.createPaymentPayload(offered)) as unknown as Permit2Proof;
}

const header = (proof: unknown) => ({
  'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64'),
});

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '10.00' });
  // Public chains have it; the SDK names a missing allowance through it
  await installMulticall3(anvil.rpcUrl);
  config = parseConfig(
    {
      version: 1,
      merchant: { id: 'permit2', name: 'Permit2', publicBaseUrl: 'http://127.0.0.1:8080' },
      server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        [RESOURCE_ID]: {
          name: 'Market report',
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
          pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
        },
      },
      payments: {
        x402: {
          enabled: true,
          network: 'eip155:31337',
          rpcUrl: anvil.rpcUrl,
          // No token domain: the buyer signs Permit2's
          asset: deployment.asset,
          assetDecimals: deployment.assetDecimals,
          assetTransferMethod: 'permit2',
          payTo: MERCHANT,
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
    paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [],
    backend,
  });
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  await store?.close();
  await anvil?.stop();
});

// The cases run in order: Permit2 is installed by the first, approved by the second
describe('x402 Permit2 settlement on Anvil', () => {
  it('fails health until Permit2 and its proxy have code', async () => {
    const missing = await freshHealth();
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain(`No Permit2 contract code found at ${PERMIT2_ADDRESS}`);

    await installPermit2(anvil.rpcUrl);
    const installed = await freshHealth();
    expect(installed.status).toBe('pass');
    expect(installed.detail).toContain('Permit2 and its x402 proxy have code');
  });

  it('answers a buyer that has not approved Permit2 with 412 and the challenge, moving nothing', async () => {
    const proof = await signedProof();
    const before = await balances();
    const refused = await invoke(header(proof));
    expect(refused.statusCode).toBe(412);
    expect(refused.json()).toMatchObject({
      code: 'PAYMENT_INVALID',
      message: 'permit2_allowance_required',
    });
    const challenge = JSON.parse(
      Buffer.from(String(refused.headers['payment-required']), 'base64').toString('utf8'),
    );
    expect(challenge.error).toBe('permit2_allowance_required');
    expect(challenge.accepts[0].extra.assetTransferMethod).toBe('permit2');
    expect(await balances()).toEqual(before);
    expect(backendCalls).toBe(0);

    const buyer = createWalletClient({
      account: privateKeyToAccount(deployment.buyer.privateKey),
      chain: anvilChain,
      transport: http(anvil.rpcUrl),
    }).extend(publicActions);
    const hash = await buyer.writeContract({
      address: deployment.asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    });
    await buyer.waitForTransactionReceipt({ hash });
  });

  it('settles an SDK-signed Permit2 payment on chain', async () => {
    const before = await balances();
    const paid = await invoke(header(await signedProof()));
    expect(paid.statusCode).toBe(200);

    const settlement = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(
      (name) => paid.headers[name.toLowerCase()] as string | undefined,
    );
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: MERCHANT,
      before,
      after: await balances(),
      amountBaseUnits: 1_000_000n,
      txHash: settlement.transaction,
    });
    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment?.payer).toBe(deployment.buyer.address);
  });

  it('a broadcast whose RPC response is lost is uncertain, never a rejection', async () => {
    const rpc = await startLossyRpc(anvil.rpcUrl);
    try {
      const lossy = createX402PaymentProvider({
        network: 'eip155:31337',
        rpcUrl: rpc.url,
        asset: deployment.asset,
        assetDecimals: deployment.assetDecimals,
        assetTransferMethod: 'permit2',
        payTo: MERCHANT,
        facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
      });
      const requirement = await lossy.createRequirement({
        requestId: 'req-lossy',
        resource: config.resources[0] as (typeof config.resources)[number],
        amount: '1.00',
        currency: 'USDC',
        requestedAt: new Date().toISOString(),
      });
      const proof = await sign(requirement.challenge.envelope as unknown as PaymentRequired);
      const context = {
        requestId: 'req-lossy',
        resource: config.resources[0] as (typeof config.resources)[number],
        requirement,
        submission: { method: 'x402' as const, payload: header(proof)['payment-signature'] },
      };
      const before = await balances();
      const verification = await lossy.verify(context);
      expect(verification.status).toBe('verified');

      // The SDK reports the lost response as its catch-all with the message
      // appended and no hash, while the transfer has landed
      await expect(lossy.settle({ ...context, verification })).rejects.toSatisfy(
        (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
      );
      assertBalanceDelta(before, await balances(), 1_000_000n);
    } finally {
      await rpc.close();
    }
  });

  it.each<[string, string, (proof: Permit2Proof) => void]>([
    [
      'a swapped witness recipient',
      'invalid_permit2_recipient_mismatch',
      (proof) => {
        proof.payload.permit2Authorization.witness.to = privateKeyToAccount(
          generatePrivateKey(),
        ).address;
      },
    ],
    [
      'an extended deadline the buyer never signed',
      'invalid_permit2_signature',
      (proof) => {
        const auth = proof.payload.permit2Authorization;
        auth.deadline = String(BigInt(auth.deadline) + 60n);
      },
    ],
  ])('refuses %s, moving nothing', async (_case, reason, tamper) => {
    const proof = await signedProof();
    tamper(proof);
    const before = await balances();
    const refused = await invoke(header(proof));
    expect(refused.statusCode).toBe(402);
    expect(refused.json().message).toBe(reason);
    expect(await balances()).toEqual(before);
  });

  it('settles one Permit2 authorization once when presented on two requests at the same time', async () => {
    const proof = await signedProof();
    const before = await balances();
    const calls = backendCalls;
    const statuses = (await Promise.all([invoke(header(proof)), invoke(header(proof))])).map(
      (response) => response.statusCode,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(backendCalls - calls).toBe(1);
    const after = await balances();
    expect(before.buyer - after.buyer).toBe(1_000_000n);
    expect(after.merchant - before.merchant).toBe(1_000_000n);
  });

  it('publishes the transfer method with the offer', async () => {
    const wellKnown = await gateway.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });
    expect(wellKnown.json().payments.x402).toMatchObject({ assetTransferMethod: 'permit2' });
    expect(wellKnown.json().payments.x402.assetName).toBeUndefined();
  });
});
