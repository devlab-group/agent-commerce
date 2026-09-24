/**
 * MPP on Base Sepolia: an mppx buyer paying through the gateway, settled by a
 * hosted x402 facilitator on the public chain.
 *
 * Like `base-sepolia.smoke.test.ts`, it spends real testnet USDC, is never part
 * of `npm test` or `npm run test:e2e`, and runs only through
 * `npm run test:testnet` on the machine that holds the wallet. It reuses that
 * suite's `X402_TESTNET_*` variables, because MPP settles through the same
 * facilitator, and skips itself, naming what is missing, without them.
 *
 * The proof is on-chain balances and a transaction receipt read back from the
 * network, never the gateway's own report of success.
 */
import { randomBytes } from 'node:crypto';
import { Challenge, Credential, Receipt } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/index.js';
import { NOOP_LOGGER, type ReceiptStore } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers.js';
import { parseCanonicalAmount } from '../../src/payments/x402/amount.js';
import { createSqliteReceiptStore } from '../../src/storage/receipts/index.js';
import {
  assertBalanceDelta,
  assertTransactionSucceeded,
  type BalanceSnapshot,
  readBalances,
  waitForBalances,
} from '../fixtures/x402/settlement.js';

const BUYER_KEY = process.env['X402_TESTNET_BUYER_PRIVATE_KEY'];
const MERCHANT = process.env['X402_TESTNET_MERCHANT_ADDRESS'];
const RPC_URL = process.env['X402_TESTNET_RPC_URL'] ?? 'https://base-sepolia-rpc.publicnode.com';
const FACILITATOR_URL =
  process.env['X402_TESTNET_FACILITATOR_URL'] ?? 'https://x402.org/facilitator';
// Small on purpose. This spends real testnet USDC on every run
const AMOUNT = process.env['X402_TESTNET_AMOUNT'] ?? '0.01';

// Circle's USDC on Base Sepolia. EIP-712 domain ("USDC", "2"), 6 decimals
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const NETWORK = 'eip155:84532';
const RESOURCE_ID = 'testnet_report';

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

const missing = [
  BUYER_KEY ? undefined : 'X402_TESTNET_BUYER_PRIVATE_KEY',
  MERCHANT ? undefined : 'X402_TESTNET_MERCHANT_ADDRESS',
].filter((name): name is string => name !== undefined);

// The config an operator would write, parsed by the real loader. The challenge
// secret is random per run and never leaves this process
function testnetConfig(): Record<string, unknown> {
  return {
    version: 1,
    merchant: {
      id: 'mpp-testnet-smoke',
      name: 'MPP Base Sepolia Smoke Test',
      publicBaseUrl: 'http://127.0.0.1:8080',
    },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Testnet report',
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: AMOUNT, currency: 'USDC' },
        expose: ['http'],
        payments: ['mpp'],
      },
    },
    payments: {
      mpp: {
        enabled: true,
        rpcUrl: RPC_URL,
        asset: USDC,
        assetName: 'USDC',
        assetVersion: '2',
        recipient: MERCHANT,
        realm: 'mpp-testnet-smoke',
        challengeSecret: randomBytes(32).toString('hex'),
        facilitator: { mode: 'remote', url: FACILITATOR_URL, auth: { type: 'none' } },
      },
    },
  };
}

let buyer: `0x${string}`;

function query() {
  return { rpcUrl: RPC_URL, asset: USDC, buyer, merchant: MERCHANT as `0x${string}` };
}

function balances(): Promise<BalanceSnapshot> {
  return readBalances(query());
}

const describeOrSkip = missing.length === 0 ? describe : describe.skip;

if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `[testnet] MPP smoke skipped - set ${missing.join(' and ')} to run it. ` +
      'It spends real testnet USDC from a dedicated wallet.',
  );
}

describeOrSkip('MPP on Base Sepolia - real settlement through a remote facilitator', () => {
  let gateway: GatewayInstance;
  let store: ReceiptStore;

  async function invoke(headers: Record<string, string> = {}) {
    return gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: {},
    });
  }

  async function credential(): Promise<string> {
    const challenged = await invoke();
    expect(challenged.statusCode).toBe(402);
    const challenge = Challenge.deserialize(String(challenged.headers['www-authenticate']));
    const client = clientCharge({
      account: privateKeyToAccount(BUYER_KEY as `0x${string}`),
      authorization: { name: 'USDC', version: '2' },
    });
    return String(
      await client.createCredential({
        challenge: challenge as unknown as EvmChallenge,
        context: {},
      }),
    );
  }

  beforeAll(async () => {
    const config = parseConfig(testnetConfig(), process.env);
    buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`).address;
    store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
    gateway = await createGateway({
      config,
      store,
      paymentProviders: createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
      protocolAdapters: [],
      backend: {
        call: async () => ({
          status: 200,
          headers: {},
          body: { report: 'mpp-base-sepolia' },
          durationMs: 1,
        }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await gateway?.close();
    await store?.close();
  });

  it('reports itself as a public testnet deployment without publishing the facilitator', async () => {
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.statusCode).toBe(200);
    expect(res.json().payments.mpp).toMatchObject({
      mode: 'testnet',
      network: NETWORK,
      facilitator: { mode: 'remote' },
    });
    expect(res.body).not.toContain(new URL(FACILITATOR_URL).hostname);
  }, 60_000);

  it('settles an mppx payment on Base Sepolia and delivers the resource', async () => {
    const before = await balances();
    expect(
      before.buyer,
      `buyer ${buyer} holds no Base Sepolia USDC - fund it at https://faucet.circle.com (no ETH needed)`,
    ).toBeGreaterThan(0n);

    const paid = await invoke({ authorization: await credential() });
    expect(paid.statusCode, `gateway refused the payment: ${paid.body}`).toBe(200);
    expect(paid.json()).toMatchObject({ report: 'mpp-base-sepolia' });

    const receipt = Receipt.deserialize(String(paid.headers['payment-receipt']));
    expect(receipt).toMatchObject({ method: 'evm', status: 'success' });

    const [stored] = await store.listReceipts({ limit: 1 });
    expect(stored?.payment).toMatchObject({
      provider: 'mpp',
      status: 'settled',
      network: NETWORK,
      externalReference: receipt.reference,
    });
    const amountBaseUnits = parseCanonicalAmount(AMOUNT, 6);
    const after = await waitForBalances(query(), (snapshot) => snapshot.buyer < before.buyer);
    assertBalanceDelta(before, after, amountBaseUnits);
    await assertTransactionSucceeded(RPC_URL, receipt.reference);

    // eslint-disable-next-line no-console
    console.log(
      `[testnet] MPP settled ${amountBaseUnits} base units to ${MERCHANT} - ` +
        `https://sepolia.basescan.org/tx/${receipt.reference}`,
    );
  }, 300_000);

  it('still fails closed: an authorization edited to pay another recipient moves nothing', async () => {
    const before = await balances();
    const genuine = Credential.deserialize(await credential()) as unknown as {
      challenge: Credential.Credential['challenge'];
      payload: Record<string, unknown>;
    };
    const edited = Credential.serialize(
      Credential.from({
        challenge: genuine.challenge,
        payload: { ...genuine.payload, to: '0x000000000000000000000000000000000000dEaD' },
      }),
    );

    const refused = await invoke({ authorization: edited });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ code: 'PAYMENT_INVALID', message: 'wrong_recipient' });

    // No polling: this asserts nothing happened, and a late transfer would
    // break the next run's exact delta instead
    const after = await balances();
    expect(after.buyer).toBe(before.buyer);
    expect(after.merchant).toBe(before.merchant);
  }, 120_000);
});
