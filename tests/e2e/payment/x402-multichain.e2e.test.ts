/**
 * EIP-3009 settlement through one gateway on Anvil chains 31338 and 31339,
 * each with MockUSDC. A loopback facilitator serves both declared testnets,
 * exercising the remote path used for non-local EVM networks. A second
 * resource offers only the second chain, through its own `x402.accepts`.
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import { type BackendExecutor, NOOP_LOGGER, type PaymentProvider } from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createPaymentProof } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { expectRealSettlement, readBalances } from '../../fixtures/x402/settlement';

const RESOURCE_ID = 'market_report';
// Offers only the second chain
const OWN_RESOURCE_ID = 'chain_b_report';
const CHAINS = [
  { network: 'eip155:31338', chainId: 31338, port: 18781 },
  { network: 'eip155:31339', chainId: 31339, port: 18782 },
] as const;
// Not an Anvil account: a well-known address is refused on a testnet deployment
const MERCHANT = privateKeyToAccount(generatePrivateKey()).address;

let anvils: AnvilHandle[] = [];
let deployments: Awaited<ReturnType<typeof deployLocalChain>>[] = [];
let facilitator: LoopbackFacilitator;
let gateway: GatewayInstance;
let provider: PaymentProvider;
let store: ReturnType<typeof createSqliteReceiptStore>;

const backend: BackendExecutor = {
  async call() {
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

const deploymentOf = (index: number) => deployments[index] as (typeof deployments)[number];
const anvilOf = (index: number) => anvils[index] as AnvilHandle;

function balancesOn(index: number) {
  const deployment = deploymentOf(index);
  return readBalances({
    rpcUrl: anvilOf(index).rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: MERCHANT,
  });
}

async function invoke(headers: Record<string, string> = {}, resourceId = RESOURCE_ID) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${resourceId}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
}

async function challenge(resourceId = RESOURCE_ID): Promise<PaymentRequired> {
  const unpaid = await invoke({}, resourceId);
  expect(unpaid.statusCode).toBe(402);
  return new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
    (name) => unpaid.headers[name.toLowerCase()] as string | undefined,
  );
}

const header = (payload: unknown) => ({
  'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64'),
});

beforeAll(async () => {
  anvils = await Promise.all(
    CHAINS.map(({ chainId, port }) => startAnvil({ chainId, port, silent: true })),
  );
  deployments = await Promise.all(
    CHAINS.map(({ chainId }, index) =>
      deployLocalChain({ rpcUrl: anvilOf(index).rpcUrl, buyerInitialBalance: '10.00', chainId }),
    ),
  );
  facilitator = await startLoopbackFacilitator({
    evm: {
      chains: CHAINS.map(({ network }, index) => ({ network, rpcUrl: anvilOf(index).rpcUrl })),
      signerPrivateKey: deploymentOf(0).facilitator.privateKey,
    },
  });

  const optionFor = (index: number) => {
    const deployment = deploymentOf(index);
    return {
      network: CHAINS[index]?.network,
      payTo: MERCHANT,
      asset: deployment.asset,
      assetName: deployment.assetName,
      assetVersion: deployment.assetVersion,
      assetDecimals: deployment.assetDecimals,
    };
  };
  const report = {
    backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
    pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
    expose: ['http'],
    payments: ['x402'],
  };
  const config = parseConfig(
    {
      version: 1,
      merchant: { id: 'multichain', name: 'Multichain', publicBaseUrl: 'http://127.0.0.1:8080' },
      server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        [RESOURCE_ID]: { name: 'Market report', ...report },
        [OWN_RESOURCE_ID]: {
          name: 'Chain B report',
          ...report,
          x402: { accepts: [optionFor(1)] },
        },
      },
      payments: {
        x402: {
          enabled: true,
          networks: Object.fromEntries(
            CHAINS.map(({ network, chainId }, index) => [
              network,
              { kind: 'testnet', displayName: `Anvil ${chainId}`, rpcUrl: anvilOf(index).rpcUrl },
            ]),
          ),
          options: CHAINS.map((_chain, index) => optionFor(index)),
          maxTimeoutSeconds: 120,
          facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
        },
      },
    },
    {},
  );
  store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  const providers = createConfiguredPaymentProviders(config.payments, NOOP_LOGGER);
  provider = providers[0] as PaymentProvider;
  gateway = await createGateway({
    config,
    store,
    paymentProviders: providers,
    protocolAdapters: [],
    backend,
  });
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  await store?.close();
  await facilitator?.close();
  await Promise.all(anvils.map((anvil) => anvil.stop()));
});

describe('x402 settlement on two EVM chains', () => {
  it.each([1, 0])('settles on chain %i and moves nothing on the other', async (pick) => {
    const other = 1 - pick;
    const offered = await challenge();
    const client = new x402Client((_version, accepts) => accepts[pick] as never);
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(deploymentOf(pick).buyer.privateKey),
      networks: CHAINS.map((c) => c.network),
    });
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(offered);

    const before = await balancesOn(pick);
    const otherBefore = await balancesOn(other);
    const paid = await invoke(header(payload));
    expect(paid.statusCode).toBe(200);

    const settlement = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(
      (name) => paid.headers[name.toLowerCase()] as string | undefined,
    );
    expect(settlement.network).toBe(CHAINS[pick]?.network);
    await expectRealSettlement({
      rpcUrl: anvilOf(pick).rpcUrl,
      asset: deploymentOf(pick).asset,
      buyer: deploymentOf(pick).buyer.address,
      merchant: MERCHANT,
      before,
      after: await balancesOn(pick),
      amountBaseUnits: 1_000_000n,
      txHash: settlement.transaction,
    });
    expect(await balancesOn(other)).toEqual(otherBefore);

    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment?.network).toBe(CHAINS[pick]?.network);
  });

  it("refuses an authorization signed for one chain and presented as the other chain's offer", async () => {
    const offered = await challenge();
    const signed = await createPaymentProof({
      buyerPrivateKey: deploymentOf(0).buyer.privateKey,
      accepts: offered.accepts[0] as unknown as Record<string, unknown>,
    });
    // Same signature, now claiming the second chain's offer
    const decoded = JSON.parse(Buffer.from(signed, 'base64').toString('utf8'));
    decoded.accepted = offered.accepts[1];

    const before = [await balancesOn(0), await balancesOn(1)];
    const refused = await invoke(header(decoded));
    expect(refused.statusCode).toBe(402);
    expect(refused.json().code).toBe('PAYMENT_INVALID');
    // Chain 31339's EIP-712 domain cannot validate the signature made for 31338
    expect(refused.json().message).toBe('invalid_exact_evm_signature');
    expect([await balancesOn(0), await balancesOn(1)]).toEqual(before);
  });

  it('keeps replay keys apart for the same payer, token address and nonce on two chains', async () => {
    const offered = await challenge();
    const nonce = `0x${'7'.repeat(64)}` as const;
    for (const pick of [0, 1]) {
      const proof = await createPaymentProof({
        buyerPrivateKey: deploymentOf(pick).buyer.privateKey,
        accepts: offered.accepts[pick] as unknown as Record<string, unknown>,
        overrides: { nonce },
      });
      const paid = await invoke({ 'payment-signature': proof });
      expect(paid.statusCode).toBe(200);
    }
  });

  it('serves a resource its own offer only, and settles it on that chain', async () => {
    const offered = await challenge(OWN_RESOURCE_ID);
    expect(offered.accepts.map((accepts) => accepts.network)).toEqual([CHAINS[1].network]);
    const client = new x402Client((_version, accepts) => accepts[0] as never);
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(deploymentOf(1).buyer.privateKey),
      networks: CHAINS.map((c) => c.network),
    });
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(offered);

    const before = await balancesOn(1);
    const otherBefore = await balancesOn(0);
    const paid = await invoke(header(payload), OWN_RESOURCE_ID);
    expect(paid.statusCode).toBe(200);
    const settlement = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(
      (name) => paid.headers[name.toLowerCase()] as string | undefined,
    );
    await expectRealSettlement({
      rpcUrl: anvilOf(1).rpcUrl,
      asset: deploymentOf(1).asset,
      buyer: deploymentOf(1).buyer.address,
      merchant: MERCHANT,
      before,
      after: await balancesOn(1),
      amountBaseUnits: 1_000_000n,
      txHash: settlement.transaction,
    });
    expect(await balancesOn(0)).toEqual(otherBefore);

    // This resource does not accept the first chain's offer
    const proof = await createPaymentProof({
      buyerPrivateKey: deploymentOf(0).buyer.privateKey,
      accepts: (await challenge()).accepts[0] as unknown as Record<string, unknown>,
    });
    const unchanged = await balancesOn(0);
    const refused = await invoke({ 'payment-signature': proof }, OWN_RESOURCE_ID);
    expect(refused.statusCode).toBe(402);
    expect(refused.json().code).toBe('PAYMENT_INVALID');
    // The offer is on another network, which verify checks before the facilitator
    expect(refused.json().message).toBe('invalid_network');
    expect(await balancesOn(0)).toEqual(unchanged);
  });

  it('checks the health of both chains', async () => {
    const health = await provider.health();
    expect(health.status).toBe('pass');
    for (const { network } of CHAINS) expect(health.detail).toContain(network);
  });
});
