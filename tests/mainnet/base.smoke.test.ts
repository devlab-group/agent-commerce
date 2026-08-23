/**
 * Base mainnet smoke test. **This spends real money.**
 *
 * Never part of `npm test`, `npm run test:e2e` or `npm run test:testnet`, and
 * never triggered by a push or a pull request. It runs only when a human sets
 * `ALLOW_X402_MAINNET=true` *and* supplies a funded buyer key, a merchant
 * address and facilitator credentials — four separate deliberate acts.
 *
 * What it proves, in the order the exit criteria ask for it:
 *
 *   the mainnet guard refuses an incomplete config
 *   -> authentication reaches the facilitator
 *   -> a real payment settles on Base
 *   -> the receipt records the settlement reference
 *   -> the resource is delivered exactly once
 *   -> the same authorisation presented again is refused
 *   -> no credential appears in anything logged
 *
 * The proof is on-chain balances and a transaction receipt read back from the
 * network, never the gateway's own report of success.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../src/config/index.js';
import { parseConfig } from '../../src/config/index.js';
import {
  isCommerceError,
  type Logger,
  PAYMENT_RESPONSE_HEADER,
  type ReceiptStore,
} from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createPaymentProof, createX402PaymentProvider } from '../../src/payments/x402/index.js';
import { createSqliteReceiptStore } from '../../src/storage/receipts/index.js';
import {
  assertBalanceDelta,
  assertTransactionSucceeded,
  type BalanceSnapshot,
  readBalances,
} from '../fixtures/x402/settlement.js';

const ALLOWED = process.env['ALLOW_X402_MAINNET'] === 'true';
const BUYER_KEY = process.env['X402_MAINNET_BUYER_PRIVATE_KEY'];
const MERCHANT = process.env['X402_MAINNET_MERCHANT_ADDRESS'];
const RPC_URL = process.env['X402_MAINNET_RPC_URL'] ?? 'https://mainnet.base.org';
const FACILITATOR_URL = process.env['X402_FACILITATOR_URL'];
const CDP_API_KEY_ID = process.env['CDP_API_KEY_ID'];
const CDP_API_KEY_SECRET = process.env['CDP_API_KEY_SECRET'];
const BEARER = process.env['X402_FACILITATOR_TOKEN'];
/** Deliberately tiny. Every run of this file moves this much real USDC. */
const AMOUNT = process.env['X402_MAINNET_AMOUNT'] ?? '0.01';

/** USDC on Base. The only asset a mainnet config is allowed to name. */
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const NETWORK = 'eip155:8453';
const RESOURCE_ID = 'mainnet_report';

const missing = [
  ALLOWED ? undefined : 'ALLOW_X402_MAINNET=true',
  BUYER_KEY ? undefined : 'X402_MAINNET_BUYER_PRIVATE_KEY',
  MERCHANT ? undefined : 'X402_MAINNET_MERCHANT_ADDRESS',
  FACILITATOR_URL ? undefined : 'X402_FACILITATOR_URL',
  CDP_API_KEY_ID || BEARER
    ? undefined
    : 'CDP_API_KEY_ID + CDP_API_KEY_SECRET (or X402_FACILITATOR_TOKEN)',
].filter((name): name is string => name !== undefined);

if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `[mainnet] skipped — needs ${missing.join(', ')}. This suite spends REAL FUNDS; see docs/mainnet.md.`,
  );
}

function authBlock(): Record<string, unknown> {
  if (CDP_API_KEY_ID && CDP_API_KEY_SECRET) {
    return { type: 'cdp', apiKeyId: CDP_API_KEY_ID, apiKeySecret: CDP_API_KEY_SECRET };
  }
  return { type: 'bearer', token: BEARER };
}

function rawConfig(overrides: { allowMainnet?: boolean } = {}): Record<string, unknown> {
  return {
    version: 1,
    merchant: {
      id: 'mainnet-smoke',
      name: 'Base Mainnet Smoke',
      publicBaseUrl: 'http://127.0.0.1:8080',
    },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Mainnet report',
        description: 'A paid resource settled on Base',
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: AMOUNT, currency: 'USD' },
        expose: ['http'],
        payments: ['x402'],
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: NETWORK,
        rpcUrl: RPC_URL,
        asset: USDC,
        assetName: 'USDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: MERCHANT,
        maxTimeoutSeconds: 600,
        ...(overrides.allowMainnet === false ? {} : { allowMainnet: true }),
        facilitator: { mode: 'remote', url: FACILITATOR_URL, auth: authBlock() },
      },
    },
  };
}

const describeOrSkip = missing.length === 0 ? describe : describe.skip;

describeOrSkip('Base mainnet — real funds', () => {
  let gateway: GatewayInstance;
  let store: ReceiptStore;
  let buyer: `0x${string}`;
  /** Everything the gateway logged, for the credential-leak assertion. */
  const logged: string[] = [];

  function balances(): Promise<BalanceSnapshot> {
    return readBalances({
      rpcUrl: RPC_URL,
      asset: USDC,
      buyer,
      merchant: MERCHANT as `0x${string}`,
    });
  }

  /**
   * Independent RPC nodes do not give read-your-writes: the facilitator
   * confirms against its node and returns while ours is still a block behind.
   * The expected delta stays exact; only the waiting is tolerant.
   */
  async function waitForBalances(
    predicate: (snapshot: BalanceSnapshot) => boolean,
    timeoutMs = 180_000,
  ): Promise<BalanceSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await balances();
    while (!predicate(snapshot) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      snapshot = await balances();
    }
    return snapshot;
  }

  beforeAll(async () => {
    const config: GatewayConfig = parseConfig(rawConfig(), process.env);
    buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`).address;

    const x402 = config.payments.x402;
    if (!x402) throw new Error('mainnet config produced no x402 provider');

    store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();

    // Captures everything the gateway and provider log, so the last assertion
    // can prove no credential reached any of it.
    const capture = (line: unknown, ...rest: unknown[]): void => {
      logged.push(JSON.stringify([line, ...rest]));
    };
    const makeLogger = (): Logger => ({
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
      child: () => makeLogger(),
    });
    const logger = makeLogger();

    gateway = await createGateway({
      config,
      store,
      logger,
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
          ...(x402.allowMainnet !== undefined ? { allowMainnet: x402.allowMainnet } : {}),
          logger,
        }),
      ],
      protocolAdapters: [],
      // Stubbed on purpose: this suite asks whether real money moved, and the
      // HTTP backend path is covered by the deterministic local E2E.
      backend: {
        call: async () => ({
          status: 200,
          headers: {},
          body: { report: 'base-mainnet' },
          durationMs: 1,
        }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await gateway?.close();
  });

  it('refuses a mainnet config that has not opted in', () => {
    // The guard is the reason this file can exist at all. If it ever stops
    // firing, every other assertion here is being made about a deployment that
    // could have been created by accident.
    try {
      parseConfig(rawConfig({ allowMainnet: false }), process.env);
      expect.unreachable('a mainnet config without allowMainnet must be refused');
    } catch (err) {
      expect(isCommerceError(err) && err.code).toBe('CONFIG_INVALID');
      expect(String((err as Error).message)).toContain('allowMainnet');
    }
  });

  it('reports itself as a live mainnet deployment', async () => {
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.statusCode).toBe(200);
    const x402 = res.json().payments.x402;
    expect(x402.mode).toBe('mainnet');
    expect(x402.network).toBe(NETWORK);
    expect(x402.asset.toLowerCase()).toBe(USDC.toLowerCase());
    expect(x402.facilitator).toEqual({ mode: 'remote' });
  }, 60_000);

  it('settles real USDC on Base, delivers once, and refuses the same authorisation twice', async () => {
    const before = await balances();
    expect(
      before.buyer,
      `buyer ${buyer} holds no USDC on Base — this suite cannot run without real funds`,
    ).toBeGreaterThan(0n);

    const challenge = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
    });
    expect(challenge.statusCode).toBe(402);
    const accepts = challenge.json().payment.accepts[0] as Record<string, unknown>;
    expect(accepts['network']).toBe(NETWORK);
    expect(accepts['payTo']).toBe(MERCHANT);
    const amountBaseUnits = BigInt(accepts['amount'] as string);

    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY as `0x${string}`,
      rpcUrl: RPC_URL,
      accepts,
    });

    const paid = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
      headers: { 'payment-signature': proof },
    });
    expect(paid.statusCode, `gateway refused the payment: ${JSON.stringify(paid.json())}`).toBe(
      200,
    );
    expect(paid.json()).toMatchObject({ report: 'base-mainnet' });

    const settlement = JSON.parse(
      Buffer.from(String(paid.headers[PAYMENT_RESPONSE_HEADER]), 'base64').toString('utf8'),
    ) as { success: boolean; transaction: string; network: string };
    expect(settlement.success).toBe(true);
    expect(settlement.network).toBe(NETWORK);

    // The chain, not the HTTP status.
    const after = await waitForBalances((snapshot) => snapshot.buyer < before.buyer);
    assertBalanceDelta(before, after, amountBaseUnits);
    await assertTransactionSucceeded(RPC_URL, settlement.transaction);

    // The receipt records where to find it, and that delivery happened.
    const receipts = await store.listReceipts();
    const settled = receipts.find((r) => r.payment?.externalReference === settlement.transaction);
    expect(settled, 'no receipt carries the settlement transaction').toBeDefined();
    expect(settled?.payment?.status).toBe('settled');
    expect(settled?.deliveredAt).toBeDefined();

    // Delivered exactly once: the same authorisation presented again is
    // refused, and no second transfer follows it.
    const replay = await gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      payload: {},
      headers: { 'payment-signature': proof },
    });
    expect(replay.statusCode).toBe(402);
    const afterReplay = await balances();
    expect(afterReplay.buyer).toBe(after.buyer);
    expect(afterReplay.merchant).toBe(after.merchant);
    expect(
      (await store.listReceipts()).filter(
        (r) => r.payment?.externalReference === settlement.transaction,
      ),
    ).toHaveLength(1);

    // eslint-disable-next-line no-console
    console.log(
      `[mainnet] settled ${accepts['amount']} base units to ${MERCHANT} — ` +
        `https://basescan.org/tx/${settlement.transaction}`,
    );
  }, 600_000);

  it('never logged a credential or a key', () => {
    const haystack = logged.join('\n');
    for (const secret of [BUYER_KEY, CDP_API_KEY_SECRET, BEARER].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )) {
      expect(haystack).not.toContain(secret);
    }
  });
});
