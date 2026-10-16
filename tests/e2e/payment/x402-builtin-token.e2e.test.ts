/**
 * EIP-3009 settlement in MockUSDC on Anvil with Base Sepolia's chain id
 * (84532), via a loopback facilitator. Health checks the token's on-chain
 * decimals.
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import { type BackendExecutor, NOOP_LOGGER, type PaymentProvider } from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { expectRealSettlement, readBalances } from '../../fixtures/x402/settlement';

const NETWORK = 'eip155:84532';
const RESOURCE_ID = 'market_report';
// Use a fresh recipient; testnet guardrails reject well-known Anvil addresses
const MERCHANT = privateKeyToAccount(generatePrivateKey()).address;

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let facilitator: LoopbackFacilitator;
let gateway: GatewayInstance;
let store: ReturnType<typeof createSqliteReceiptStore>;

const backend: BackendExecutor = {
  async call() {
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

// A custom token with explicit metadata on a built-in network
function configWith(assetDecimals: number) {
  return parseConfig(
    {
      version: 1,
      merchant: { id: 'token', name: 'Token', publicBaseUrl: 'http://127.0.0.1:8080' },
      server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        [RESOURCE_ID]: {
          name: 'Market report',
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
          pricing: { type: 'fixed', amount: '1.00', currency: 'EURC' },
          expose: ['http'],
          payments: ['x402'],
        },
      },
      payments: {
        x402: {
          enabled: true,
          network: NETWORK,
          rpcUrl: anvil.rpcUrl,
          asset: deployment.asset,
          assetName: deployment.assetName,
          assetVersion: deployment.assetVersion,
          assetDecimals,
          payTo: MERCHANT,
          maxTimeoutSeconds: 120,
          facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
        },
      },
    },
    {},
  );
}

function balances() {
  return readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: MERCHANT,
  });
}

beforeAll(async () => {
  anvil = await startAnvil({ chainId: 84532, port: 18783, silent: true });
  deployment = await deployLocalChain({
    rpcUrl: anvil.rpcUrl,
    buyerInitialBalance: '10.00',
    chainId: 84532,
  });
  facilitator = await startLoopbackFacilitator({
    evm: {
      chains: [{ network: NETWORK, rpcUrl: anvil.rpcUrl }],
      signerPrivateKey: deployment.facilitator.privateKey,
    },
  });
  const config = configWith(deployment.assetDecimals);
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
  await facilitator?.close();
  await anvil?.stop();
});

describe('x402 settlement in another token on a built-in network', () => {
  it('settles in the configured token and records the resource label', async () => {
    const invoke = (headers: Record<string, string> = {}) =>
      gateway.server.inject({
        method: 'POST',
        url: `/api/resources/${RESOURCE_ID}/invoke`,
        headers: { 'content-type': 'application/json', ...headers },
        payload: {},
      });
    const unpaid = await invoke();
    expect(unpaid.statusCode).toBe(402);
    const offered = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
      (name) => unpaid.headers[name.toLowerCase()] as string | undefined,
    );
    expect(offered.accepts).toHaveLength(1);
    expect(offered.accepts[0]).toMatchObject({
      network: NETWORK,
      asset: deployment.asset,
      amount: '1000000',
    });

    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(deployment.buyer.privateKey),
      networks: [NETWORK],
    });
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(offered);

    const before = await balances();
    const paid = await invoke({
      'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64'),
    });
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
    expect(receipt?.payment).toMatchObject({
      network: NETWORK,
      asset: getAddress(deployment.asset),
      amount: '1',
      currency: 'EURC',
      externalReference: settlement.transaction,
    });
  });

  it('checks configured decimals against the token during health', async () => {
    const health = async (assetDecimals: number) => {
      const config = configWith(assetDecimals);
      const providers = await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER);
      return (providers[0] as PaymentProvider).health();
    };
    expect((await health(deployment.assetDecimals)).status).toBe('pass');
    const wrong = await health(18);
    expect(wrong.status).toBe('fail');
    expect(wrong.detail).toBe(
      `Token ${deployment.asset} has ${deployment.assetDecimals} decimals, configured 18`,
    );
  });
});
