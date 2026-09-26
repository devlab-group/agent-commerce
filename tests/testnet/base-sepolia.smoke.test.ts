/**
 * Base Sepolia smoke test. It spends real testnet USDC through a public RPC
 * and a hosted facilitator, so only `npm run test:testnet` runs it, never CI
 * (see vitest.testnet.config.ts). Without credentials it skips and names the
 * missing variable.
 *
 * What it proves, in order:
 *
 *   agent request -> 402 v2 challenge -> buyer signature -> remote
 *   facilitator -> Base Sepolia settlement -> merchant balance rises ->
 *   resource delivered -> receipt carries the settlement reference
 *
 * The proof is on-chain balances and a transaction receipt read back from the
 * network, never the gateway's own report of success.
 *
 * The buyer key comes from the environment and is never written to disk,
 * logged or put in an assertion message.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../src/config';
import { parseConfig } from '../../src/config';
import type { ReceiptStore } from '../../src/core';
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createPaymentProof, createX402PaymentProvider } from '../../src/payments/x402';
import { createSqliteReceiptStore } from '../../src/storage/receipts';
import {
  assertBalanceDelta,
  assertTransactionSucceeded,
  type BalanceSnapshot,
  waitForBalances as pollBalances,
  readBalances,
} from '../fixtures/x402/settlement';

const BUYER_KEY = process.env['X402_TESTNET_BUYER_PRIVATE_KEY'];
const MERCHANT = process.env['X402_TESTNET_MERCHANT_ADDRESS'];
const RPC_URL = process.env['X402_TESTNET_RPC_URL'] ?? 'https://base-sepolia-rpc.publicnode.com';
const FACILITATOR_URL =
  process.env['X402_TESTNET_FACILITATOR_URL'] ?? 'https://x402.org/facilitator';
// Small on purpose: every run spends this much real testnet USDC
const AMOUNT = process.env['X402_TESTNET_AMOUNT'] ?? '0.01';

// Circle's USDC on Base Sepolia. EIP-712 domain ("USDC", "2"), 6 decimals
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const NETWORK = 'eip155:84532';
const RESOURCE_ID = 'testnet_report';

const missing = [
  BUYER_KEY ? undefined : 'X402_TESTNET_BUYER_PRIVATE_KEY',
  MERCHANT ? undefined : 'X402_TESTNET_MERCHANT_ADDRESS',
].filter((name): name is string => name !== undefined);

// The YAML an operator would write, parsed by the real loader, which shows a
// public testnet needs configuration and nothing else
function testnetConfigYaml(): string {
  return `version: 1
merchant:
  id: testnet-smoke
  name: Base Sepolia Smoke Test
  publicBaseUrl: http://127.0.0.1:8080
server:
  port: 8080
  host: 127.0.0.1
  allowedOrigins: []
storage:
  receipts:
    driver: sqlite
    path: ":memory:"
protocols:
  http:
    enabled: true
  mcp:
    enabled: false
    mountPath: /mcp
resources:
  ${RESOURCE_ID}:
    name: Testnet report
    description: A paid resource settled on Base Sepolia
    backend:
      type: http
      method: GET
      url: http://merchant.invalid/api/report
    pricing:
      type: fixed
      amount: "${AMOUNT}"
      currency: USD
    expose: [http]
    payments: [x402]
payments:
  x402:
    enabled: true
    network: ${NETWORK}
    rpcUrl: ${RPC_URL}
    asset: "${USDC}"
    assetName: USDC
    assetVersion: "2"
    assetDecimals: 6
    payTo: "${MERCHANT}"
    maxTimeoutSeconds: 300
    facilitator:
      mode: remote
      url: ${FACILITATOR_URL}
      auth:
        type: none
`;
}

// This suite's balances, polled because our RPC node can lag the facilitator's
function waitForBalances(
  predicate: (snapshot: BalanceSnapshot) => boolean,
): Promise<BalanceSnapshot> {
  return pollBalances(
    { rpcUrl: RPC_URL, asset: USDC, buyer, merchant: MERCHANT as `0x${string}` },
    predicate,
  );
}

function balances(): Promise<BalanceSnapshot> {
  return readBalances({
    rpcUrl: RPC_URL,
    asset: USDC,
    buyer,
    merchant: MERCHANT as `0x${string}`,
  });
}

let buyer: `0x${string}`;

const describeOrSkip = missing.length === 0 ? describe : describe.skip;

if (missing.length > 0) {
  console.log(
    `[testnet] skipped - set ${missing.join(' and ')} to run the Base Sepolia smoke test. ` +
      'It spends real testnet USDC from a dedicated wallet.',
  );
}

describeOrSkip('Base Sepolia - real settlement through a remote facilitator', () => {
  let gateway: GatewayInstance;
  let config: GatewayConfig;
  let store: ReceiptStore;

  beforeAll(async () => {
    config = parseConfig((await import('yaml')).parse(testnetConfigYaml()) as unknown, process.env);
    buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`).address;

    const x402 = config.payments.x402;
    if (!x402) throw new Error('testnet config produced no x402 provider');

    store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();

    gateway = await createGateway({
      config,
      store,
      paymentProviders: [
        createX402PaymentProvider({
          network: x402.network,
          rpcUrl: x402.rpcUrl,
          asset: x402.asset as `0x${string}`,
          assetName: x402.assetName,
          assetVersion: x402.assetVersion,
          assetDecimals: x402.assetDecimals,
          payTo: x402.payTo as `0x${string}`,
          maxTimeoutSeconds: x402.maxTimeoutSeconds,
          facilitator: x402.facilitator,
        }),
      ],
      protocolAdapters: [],
      // Stubbed: this suite asks whether money moved on a public chain, and the
      // local E2E suites cover the HTTP backend path
      backend: {
        call: async () => ({
          status: 200,
          headers: {},
          body: { report: 'base-sepolia', at: new Date().toISOString() },
          durationMs: 1,
        }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await gateway?.close();
  });

  it('reports itself as a public testnet deployment, not as local', async () => {
    const res = await gateway.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });
    expect(res.statusCode).toBe(200);
    const x402 = res.json().payments.x402;
    expect(x402.mode).toBe('testnet');
    expect(x402.network).toBe(NETWORK);
    expect(x402.facilitator).toEqual({ mode: 'remote' });
    // The facilitator endpoint is never published, like rpcUrl
    expect(JSON.stringify(res.json())).not.toContain(new URL(FACILITATOR_URL).hostname);
  }, 60_000);

  it('settles a real payment on Base Sepolia and delivers the resource', async () => {
    const before = await balances();

    // Without funds nothing below works, and "expected 402 to be 200" would not
    // say why. Fail here, naming the address to top up.
    expect(
      before.buyer,
      `buyer ${buyer} holds no Base Sepolia USDC - fund it at https://faucet.circle.com (no ETH needed)`,
    ).toBeGreaterThan(0n);

    // 1. The agent asks, unpaid
    const challenge = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
    });
    expect(challenge.statusCode).toBe(402);
    expect(challenge.headers[PAYMENT_REQUIRED_HEADER]).toBeDefined();

    const accepts = challenge.json().payment.accepts[0] as Record<string, unknown>;
    expect(accepts['network']).toBe(NETWORK);
    expect(accepts['payTo']).toBe(MERCHANT);
    const amountBaseUnits = BigInt(accepts['amount'] as string);

    // 2. The buyer signs it offline. No gas, and the gateway holds no key
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY as `0x${string}`,
      accepts,
    });

    // 3. The gateway verifies and settles through the remote facilitator
    const paid = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
      headers: { 'payment-signature': proof },
    });
    expect(paid.statusCode, `gateway refused the payment: ${JSON.stringify(paid.json())}`).toBe(
      200,
    );
    expect(paid.json()).toMatchObject({ report: 'base-sepolia' });

    const settleHeader = paid.headers[PAYMENT_RESPONSE_HEADER];
    expect(settleHeader).toBeDefined();
    const settlement = JSON.parse(Buffer.from(String(settleHeader), 'base64').toString('utf8')) as {
      success: boolean;
      transaction: string;
      network: string;
    };
    expect(settlement.success).toBe(true);
    expect(settlement.network).toBe(NETWORK);

    // 4. The chain is the proof, not the HTTP status
    const after = await waitForBalances((snapshot) => snapshot.buyer < before.buyer);
    assertBalanceDelta(before, after, amountBaseUnits);
    await assertTransactionSucceeded(RPC_URL, settlement.transaction);

    // 5. The merchant's ledger records where to find it. Read from the store:
    // this config sets no admin token, so the operator route answers 404.
    const receipts = await store.listReceipts();
    const settled = receipts.find((r) => r.payment?.externalReference === settlement.transaction);
    expect(settled, 'no receipt carries the settlement transaction').toBeDefined();
    expect(settled?.payment?.status).toBe('settled');
    expect(settled?.payment?.network).toBe(NETWORK);
    // A 2xx backend status is what marks the receipt delivered
    expect(settled?.backendStatus).toBeGreaterThanOrEqual(200);
    expect(settled?.backendStatus).toBeLessThan(300);

    console.log(
      `[testnet] settled ${accepts['amount']} base units to ${MERCHANT} - ` +
        `https://sepolia.basescan.org/tx/${settlement.transaction}`,
    );
  }, 300_000);

  it('still fails closed: a tampered authorization is refused and moves nothing', async () => {
    const before = await balances();

    const challenge = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
    });
    const accepts = challenge.json().payment.accepts[0] as Record<string, unknown>;

    // Signed for a different recipient than the challenge names
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY as `0x${string}`,
      accepts,
      overrides: { payTo: '0x000000000000000000000000000000000000dEaD' },
    });

    const refused = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
      headers: { 'payment-signature': proof },
    });
    expect(refused.statusCode).toBe(402);

    // No polling: this asserts nothing happened, and a late transfer would
    // break the next run's exact delta instead
    const after = await balances();
    expect(after.buyer).toBe(before.buyer);
    expect(after.merchant).toBe(before.merchant);
  }, 120_000);
});
