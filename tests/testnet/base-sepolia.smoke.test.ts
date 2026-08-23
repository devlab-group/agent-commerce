/**
 * Base Sepolia smoke test — the first flow in this project that settles on a
 * public chain.
 *
 * Deliberately NOT part of `npm test` or `npm run test:e2e`: those must stay
 * deterministic and offline. This one spends real testnet USDC, talks to a
 * public RPC and a hosted facilitator, and is run on demand
 * (`npm run test:testnet`) or from the manual GitHub Actions workflow.
 *
 * It skips itself — loudly, naming the variable — when the credentials are
 * absent, so a developer who runs it by accident gets an explanation rather
 * than a failure.
 *
 * What it proves, end to end and in that order:
 *
 *   agent request -> 402 v2 challenge -> buyer signature -> remote
 *   facilitator -> Base Sepolia settlement -> merchant balance rises ->
 *   resource delivered -> receipt carries the settlement reference
 *
 * The proof is on-chain balances and a real transaction receipt read back
 * from the network, never the gateway's own report of success.
 *
 * SECRETS: the buyer key is read from the environment and never written to
 * config on disk, never logged, and never included in an assertion message.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../src/config/index.js';
import { parseConfig } from '../../src/config/index.js';
import type { ReceiptStore } from '../../src/core/index.js';
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createPaymentProof, createX402PaymentProvider } from '../../src/payments/x402/index.js';
import { createSqliteReceiptStore } from '../../src/storage/receipts/index.js';
import {
  assertBalanceDelta,
  assertTransactionSucceeded,
  type BalanceSnapshot,
  readBalances,
} from '../fixtures/x402/settlement.js';

const BUYER_KEY = process.env['X402_TESTNET_BUYER_PRIVATE_KEY'];
const MERCHANT = process.env['X402_TESTNET_MERCHANT_ADDRESS'];
const RPC_URL = process.env['X402_TESTNET_RPC_URL'] ?? 'https://base-sepolia-rpc.publicnode.com';
const FACILITATOR_URL =
  process.env['X402_TESTNET_FACILITATOR_URL'] ?? 'https://x402.org/facilitator';
/** Small on purpose. This spends real testnet USDC on every run. */
const AMOUNT = process.env['X402_TESTNET_AMOUNT'] ?? '0.01';

/** Circle's USDC on Base Sepolia. EIP-712 domain ("USDC", "2"), 6 decimals. */
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const NETWORK = 'eip155:84532';
const RESOURCE_ID = 'testnet_report';

const missing = [
  BUYER_KEY ? undefined : 'X402_TESTNET_BUYER_PRIVATE_KEY',
  MERCHANT ? undefined : 'X402_TESTNET_MERCHANT_ADDRESS',
].filter((name): name is string => name !== undefined);

/**
 * The same YAML an operator would write, parsed by the real loader — so this
 * also proves a public testnet needs configuration and nothing else.
 */
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

/**
 * Read-your-writes does not hold across independent RPC nodes.
 *
 * The facilitator confirms the transfer against *its* node and returns; the
 * node this suite reads from is a different one and can be a block or two
 * behind. Reading once immediately after settlement therefore sees the old
 * balances and reports "nothing moved" for a payment that plainly did — which
 * is exactly what happened on the first real run here.
 *
 * Polling is the fix for the lag, not a way to soften the assertion: the
 * expected delta is still exact, the timeout is bounded, and a settlement that
 * never lands still fails.
 */
async function waitForBalances(
  predicate: (snapshot: BalanceSnapshot) => boolean,
  timeoutMs = 90_000,
): Promise<BalanceSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await balances();
  while (!predicate(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    snapshot = await balances();
  }
  return snapshot;
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
  // eslint-disable-next-line no-console
  console.log(
    `[testnet] skipped — set ${missing.join(' and ')} to run the Base Sepolia smoke test. ` +
      'It spends real testnet USDC from a dedicated wallet; see docs/testnet.md.',
  );
}

describeOrSkip('Base Sepolia — real settlement through a remote facilitator', () => {
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
      // The merchant backend is stubbed: this suite is about whether money
      // moved on a public chain, and the real HTTP backend path is already
      // covered by the deterministic local E2E.
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
    // The facilitator endpoint is never published, exactly like rpcUrl.
    expect(JSON.stringify(res.json())).not.toContain(new URL(FACILITATOR_URL).hostname);
  }, 60_000);

  it('settles a real payment on Base Sepolia and delivers the resource', async () => {
    const before = await balances();

    // Nothing below can work without funds, and "expected 402 to be 200" does
    // not say so. Fail here instead, naming the address to top up.
    expect(
      before.buyer,
      `buyer ${buyer} holds no Base Sepolia USDC — fund it at https://faucet.circle.com (no ETH needed)`,
    ).toBeGreaterThan(0n);

    // 1. The agent asks, unpaid.
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

    // 2. The buyer signs it, offline. No gas, no key held by the gateway.
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY as `0x${string}`,
      rpcUrl: RPC_URL,
      accepts,
    });

    // 3. The gateway verifies and settles through the remote facilitator.
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

    // 4. The chain is the proof, not the HTTP status.
    const after = await waitForBalances((snapshot) => snapshot.buyer < before.buyer);
    assertBalanceDelta(before, after, amountBaseUnits);
    await assertTransactionSucceeded(RPC_URL, settlement.transaction);

    // 5. And the merchant's own ledger records where to find it. Read from the
    // store rather than the operator route, which this config leaves
    // unauthenticated — and therefore 404 — on purpose.
    const receipts = await store.listReceipts();
    const settled = receipts.find((r) => r.payment?.externalReference === settlement.transaction);
    expect(settled, 'no receipt carries the settlement transaction').toBeDefined();
    expect(settled?.payment?.status).toBe('settled');
    expect(settled?.payment?.network).toBe(NETWORK);
    // Paid AND delivered: a settled payment with no delivery is the failure
    // mode the receipt exists to make visible.
    expect(settled?.deliveredAt).toBeDefined();

    // eslint-disable-next-line no-console
    console.log(
      `[testnet] settled ${accepts['amount']} base units to ${MERCHANT} — ` +
        `https://sepolia.basescan.org/tx/${settlement.transaction}`,
    );
  }, 300_000);

  it('still fails closed: a tampered authorisation is refused and moves nothing', async () => {
    const before = await balances();

    const challenge = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
    });
    const accepts = challenge.json().payment.accepts[0] as Record<string, unknown>;

    // Signed for a different recipient than the one the challenge names.
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY as `0x${string}`,
      rpcUrl: RPC_URL,
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

    // No polling here, deliberately: this asserts nothing happened, and
    // waiting for a change that must never come would only slow the suite. The
    // lag cuts the safe way round — a late-arriving transfer would show up in
    // the next run's `before`, where the exact-delta assertion would fail.
    const after = await balances();
    expect(after.buyer).toBe(before.buyer);
    expect(after.merchant).toBe(before.merchant);
  }, 120_000);
});
