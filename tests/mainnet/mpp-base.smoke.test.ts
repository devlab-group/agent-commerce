/**
 * MPP smoke test on Base mainnet. This spends real USDC.
 *
 * This file belongs to `npm run test:mainnet`; CI and the offline suites
 * exclude it. It runs when `ALLOW_MPP_MAINNET=true` and the buyer key, merchant
 * address, and facilitator URL are set. The RPC URL and facilitator credential
 * are optional. Missing required values skip the suite and are named in output.
 *
 * Success requires the expected on-chain balance changes and a successful
 * transaction receipt fetched from Base. The gateway's HTTP status alone is
 * not proof of settlement.
 */
import { randomBytes } from 'node:crypto';
import { Challenge, Receipt } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/index.js';
import { isCommerceError, type Logger, type ReceiptStore } from '../../src/core/index.js';
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

const ALLOWED = process.env['ALLOW_MPP_MAINNET'] === 'true';
const BUYER_KEY = process.env['X402_MAINNET_BUYER_PRIVATE_KEY'];
const MERCHANT = process.env['X402_MAINNET_MERCHANT_ADDRESS'];
const RPC_URL = process.env['X402_MAINNET_RPC_URL'] ?? 'https://base.drpc.org';
const FACILITATOR_URL = process.env['X402_FACILITATOR_URL'];
const CDP_API_KEY_ID = process.env['CDP_API_KEY_ID'];
const CDP_API_KEY_SECRET = process.env['CDP_API_KEY_SECRET'];
const BEARER = process.env['X402_FACILITATOR_TOKEN'];
// A successful settlement moves this much real USDC; change it deliberately
const AMOUNT = process.env['X402_MAINNET_AMOUNT'] ?? '0.01';

// Canonical Base USDC; mainnet guardrails also require its EIP-712 name and version
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const NETWORK = 'eip155:8453';
const RESOURCE_ID = 'mainnet_report';
const CHALLENGE_SECRET = randomBytes(32).toString('hex');

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

const missing = [
  ALLOWED ? undefined : 'ALLOW_MPP_MAINNET=true',
  BUYER_KEY ? undefined : 'X402_MAINNET_BUYER_PRIVATE_KEY',
  MERCHANT ? undefined : 'X402_MAINNET_MERCHANT_ADDRESS',
  FACILITATOR_URL ? undefined : 'X402_FACILITATOR_URL',
].filter((name): name is string => name !== undefined);

if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.log(`[mainnet] MPP skipped - needs ${missing.join(', ')}. This suite spends REAL FUNDS.`);
}

function authBlock(): Record<string, unknown> {
  if (CDP_API_KEY_ID && CDP_API_KEY_SECRET) {
    return { type: 'cdp', apiKeyId: CDP_API_KEY_ID, apiKeySecret: CDP_API_KEY_SECRET };
  }
  if (BEARER) return { type: 'bearer', token: BEARER };
  return { type: 'none' };
}

function rawConfig(overrides: { allowMainnet?: boolean } = {}): Record<string, unknown> {
  return {
    version: 1,
    merchant: {
      id: 'mpp-mainnet-smoke',
      name: 'MPP Base Mainnet Smoke',
      publicBaseUrl: 'http://127.0.0.1:8080',
    },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Mainnet report',
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: AMOUNT, currency: 'USDC' },
        expose: ['http'],
        payments: ['mpp'],
      },
    },
    payments: {
      mpp: {
        enabled: true,
        network: NETWORK,
        rpcUrl: RPC_URL,
        asset: USDC,
        assetName: 'USD Coin',
        assetVersion: '2',
        recipient: MERCHANT,
        realm: 'mpp-mainnet-smoke',
        challengeSecret: CHALLENGE_SECRET,
        ...(overrides.allowMainnet === false ? {} : { allowMainnet: true }),
        // Required only when authBlock() returns no credential
        allowUnauthenticatedFacilitator: true,
        facilitator: { mode: 'remote', url: FACILITATOR_URL, auth: authBlock() },
      },
    },
  };
}

const describeOrSkip = missing.length === 0 ? describe : describe.skip;

describeOrSkip('MPP on Base mainnet - real funds', () => {
  let gateway: GatewayInstance;
  let store: ReceiptStore;
  let buyer: `0x${string}`;
  // Capture gateway and provider logs for the secret-leak check
  const logged: string[] = [];

  function query() {
    return { rpcUrl: RPC_URL, asset: USDC, buyer, merchant: MERCHANT as `0x${string}` };
  }

  function balances(): Promise<BalanceSnapshot> {
    return readBalances(query());
  }

  async function invoke(headers: Record<string, string> = {}) {
    return gateway.server.inject({
      method: 'POST',
      url: `/api/resources/${RESOURCE_ID}/invoke`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: {},
    });
  }

  beforeAll(async () => {
    const config = parseConfig(rawConfig(), process.env);
    buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`).address;
    store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();

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
      paymentProviders: createConfiguredPaymentProviders(config.payments, logger),
      protocolAdapters: [],
      backend: {
        call: async () => ({
          status: 200,
          headers: {},
          body: { report: 'mpp-base-mainnet' },
          durationMs: 1,
        }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await gateway?.close();
    await store?.close();
  });

  it('refuses a mainnet MPP config that has not opted in', () => {
    try {
      parseConfig(rawConfig({ allowMainnet: false }), process.env);
      expect.unreachable('a mainnet MPP config without allowMainnet must be refused');
    } catch (err) {
      expect(isCommerceError(err) && err.code).toBe('CONFIG_INVALID');
      expect(String((err as Error).message)).toContain('payments.mpp.allowMainnet');
    }
  });

  it('reports itself as a live mainnet deployment', async () => {
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' });
    expect(res.statusCode).toBe(200);
    expect(res.json().payments.mpp).toMatchObject({
      mode: 'mainnet',
      network: NETWORK,
      facilitator: { mode: 'remote' },
    });
  }, 60_000);

  it('settles real USDC on Base over MPP, delivers once, and refuses the same credential twice', async () => {
    const before = await balances();
    expect(
      before.buyer,
      `buyer ${buyer} holds no USDC on Base - this suite cannot run without real funds`,
    ).toBeGreaterThan(0n);

    const challenged = await invoke();
    expect(challenged.statusCode).toBe(402);
    const challenge = Challenge.deserialize(String(challenged.headers['www-authenticate']));
    const request = challenge.request as { methodDetails: { chainId: number } };
    expect(request.methodDetails.chainId).toBe(8453);
    const client = clientCharge({
      account: privateKeyToAccount(BUYER_KEY as `0x${string}`),
      authorization: { name: 'USD Coin', version: '2' },
    });
    const credential = String(
      await client.createCredential({
        challenge: challenge as unknown as EvmChallenge,
        context: {},
      }),
    );

    const paid = await invoke({ authorization: credential });
    expect(paid.statusCode, `gateway refused the payment: ${paid.body}`).toBe(200);
    expect(paid.json()).toMatchObject({ report: 'mpp-base-mainnet' });
    const receipt = Receipt.deserialize(String(paid.headers['payment-receipt']));

    // Verify settlement on-chain instead of trusting the HTTP status
    const amountBaseUnits = parseCanonicalAmount(AMOUNT, 6);
    const after = await waitForBalances(query(), (s) => s.buyer < before.buyer, 180_000);
    assertBalanceDelta(before, after, amountBaseUnits);
    await assertTransactionSucceeded(RPC_URL, receipt.reference);

    const [stored] = await store.listReceipts({ limit: 1 });
    expect(stored?.payment).toMatchObject({
      provider: 'mpp',
      status: 'settled',
      network: NETWORK,
      externalReference: receipt.reference,
    });
    expect(stored?.deliveredAt).toBeDefined();

    const replay = await invoke({ authorization: credential });
    expect(replay.statusCode).toBe(409);
    const afterReplay = await balances();
    expect(afterReplay.buyer).toBe(after.buyer);
    expect(afterReplay.merchant).toBe(after.merchant);

    // eslint-disable-next-line no-console
    console.log(
      `[mainnet] MPP settled ${amountBaseUnits} base units - https://basescan.org/tx/${receipt.reference}`,
    );
  }, 300_000);

  it('does not log configured payment secrets', () => {
    const secrets = [BUYER_KEY, CHALLENGE_SECRET, CDP_API_KEY_SECRET, BEARER].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const all = logged.join('\n');
    for (const secret of secrets) expect(all.includes(secret)).toBe(false);
  });
});
