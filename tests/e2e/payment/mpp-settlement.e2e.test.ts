/**
 * MPP settling on a real local chain, through the whole gateway.
 *
 * The buyer is the mppx client. Gateways are built from parsed config through
 * the provider builder `main.ts` uses, so MPP settles through its internal x402
 * provider and local facilitator. Every outcome is read back off the chain:
 * balance deltas and transaction receipts, never a log line.
 *
 * The chain is an ephemeral Anvil this file spawns; the merchant backend is
 * stubbed, because what is under test is everything in front of it.
 */
import { Challenge, Credential, Receipt } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { createTestClient, http, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/index.js';
import {
  type BackendExecutor,
  NOOP_LOGGER,
  PAYMENT_HEADER,
  type ReceiptStore,
} from '../../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../../src/gateway/index.js';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers.js';
import { createPaymentProof } from '../../../src/payments/x402/index.js';
import {
  type AnvilHandle,
  deployLocalChain,
  startAnvil,
} from '../../../src/payments/x402/testing.js';
import { createSqliteReceiptStore } from '../../../src/storage/receipts/index.js';
import { expectRealSettlement, readBalances } from '../../fixtures/x402/settlement.js';

const PORT = 18792;
const RESOURCE_ID = 'market_report';
const SECRET = 'mpp-e2e-challenge-secret'.padEnd(32, 'x');
const ONE_USDC = 1_000_000n;

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

interface GatewayOptions {
  readonly x402?: boolean;
  readonly mpp?: Record<string, unknown>;
}

interface Running {
  readonly gateway: GatewayInstance;
  readonly store: ReceiptStore;
}

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let buyer: LocalAccount;
let backendCalls = 0;
const running: Running[] = [];

const backend: BackendExecutor = {
  async call() {
    backendCalls += 1;
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

// One resource, one price, both rails named. The enabled rail serves it, or the
// first-listed one when both are enabled; the buyer never chooses.
function rawConfig(options: GatewayOptions): Record<string, unknown> {
  const facilitator = { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey };
  return {
    version: 1,
    merchant: { id: 'mpp-e2e', name: 'MPP E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Market report',
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
        expose: ['http'],
        payments: ['x402', 'mpp'],
      },
    },
    payments: {
      ...(options.x402
        ? {
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
              facilitator,
            },
          }
        : {}),
      mpp: {
        enabled: true,
        rpcUrl: anvil.rpcUrl,
        asset: deployment.asset,
        assetName: deployment.assetName,
        assetVersion: deployment.assetVersion,
        recipient: deployment.merchant.address,
        realm: 'gateway.e2e',
        challengeSecret: SECRET,
        facilitator,
        ...options.mpp,
      },
    },
  };
}

async function startGateway(options: GatewayOptions = {}): Promise<Running> {
  const config = parseConfig(rawConfig(options), {});
  const store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  const gateway = await createGateway({
    config,
    store,
    paymentProviders: createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [],
    backend,
  });
  const started = { gateway, store };
  running.push(started);
  return started;
}

interface Invocation {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: Record<string, unknown>;
}

async function invoke(
  gateway: GatewayInstance,
  headers: Record<string, string> = {},
): Promise<Invocation> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
  return { statusCode: res.statusCode, headers: res.headers, body: res.json() };
}

// Asks for the resource unpaid, then pays the challenge with the mppx client
async function mppCredential(
  gateway: GatewayInstance,
  options: { account?: LocalAccount; assetName?: string } = {},
): Promise<string> {
  const challenged = await invoke(gateway);
  expect(challenged.statusCode).toBe(402);
  const challenge = Challenge.deserialize(String(challenged.headers['www-authenticate']));
  const client = clientCharge({
    account: options.account ?? buyer,
    authorization: {
      name: options.assetName ?? deployment.assetName,
      version: deployment.assetVersion,
    },
  });
  return String(
    await client.createCredential({ challenge: challenge as unknown as EvmChallenge, context: {} }),
  );
}

interface MutableCredential {
  challenge: { request: Record<string, unknown> & { methodDetails: Record<string, unknown> } };
  payload: Record<string, unknown>;
}

// Re-serialises a genuine credential with one change and nothing re-signed
function altered(credential: string, change: (copy: MutableCredential) => void): string {
  const copy = structuredClone(Credential.deserialize(credential)) as unknown as MutableCredential;
  change(copy);
  return Credential.serialize(Credential.from(copy as unknown as Credential.Credential));
}

async function balances() {
  return readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: deployment.merchant.address,
  });
}

// A refused payment: no delivery and no balance change on chain
async function expectRefused(
  gateway: GatewayInstance,
  credential: string,
  expected: { statusCode: number; code: string; message?: string },
): Promise<Invocation> {
  const before = await balances();
  const callsBefore = backendCalls;

  const refused = await invoke(gateway, { authorization: credential });

  expect(refused.statusCode).toBe(expected.statusCode);
  expect(refused.body['code']).toBe(expected.code);
  if (expected.message !== undefined) expect(refused.body['message']).toBe(expected.message);
  expect(backendCalls).toBe(callsBefore);
  expect(await balances()).toEqual(before);
  return refused;
}

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  buyer = privateKeyToAccount(deployment.buyer.privateKey);
}, 180_000);

afterAll(async () => {
  for (const { gateway, store } of running) {
    await gateway.close().catch(() => {});
    await store.close().catch(() => {});
  }
  await anvil?.stop();
});

describe('MPP settlement - real local chain', () => {
  it('1. a credential from the mppx client settles on chain, delivers once and returns a Payment-Receipt', async () => {
    const { gateway, store } = await startGateway();
    const credential = await mppCredential(gateway);
    const before = await balances();
    const callsBefore = backendCalls;

    const paid = await invoke(gateway, { authorization: credential });

    expect(paid.statusCode).toBe(200);
    expect(backendCalls).toBe(callsBefore + 1);
    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment).toMatchObject({ provider: 'mpp', status: 'settled' });
    const txHash = receipt?.payment?.externalReference as string;
    expect(Receipt.deserialize(String(paid.headers['payment-receipt']))).toMatchObject({
      method: 'evm',
      reference: txHash,
      status: 'success',
    });
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await balances(),
      amountBaseUnits: ONE_USDC,
      txHash,
    });
  });

  it('2. the same resource and price settle over x402 on a gateway that enables x402 too', async () => {
    const mppOnly = await startGateway();
    const mppChallenge = Challenge.deserialize(
      String((await invoke(mppOnly.gateway)).headers['www-authenticate']),
    );
    const { gateway, store } = await startGateway({ x402: true });
    const challenged = await invoke(gateway);
    const payment = challenged.body['payment'] as {
      provider: string;
      accepts: Record<string, unknown>[];
    };

    // Each rail prices the one canonical amount in its own challenge
    expect(payment.provider).toBe('x402');
    expect(payment.accepts[0]?.['amount']).toBe(ONE_USDC.toString());
    expect((mppChallenge.request as { amount: string }).amount).toBe(ONE_USDC.toString());

    const proof = await createPaymentProof({
      buyerPrivateKey: deployment.buyer.privateKey,
      rpcUrl: anvil.rpcUrl,
      accepts: payment.accepts[0] as Record<string, unknown>,
    });
    const before = await balances();
    expect((await invoke(gateway, { [PAYMENT_HEADER]: proof })).statusCode).toBe(200);

    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment?.provider).toBe('x402');
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await balances(),
      amountBaseUnits: ONE_USDC,
      txHash: receipt?.payment?.externalReference as string,
    });
  });

  describe('3. refused before settlement, with nothing moved', () => {
    const invalid = (message: string) => ({ statusCode: 402, code: 'PAYMENT_INVALID', message });

    it.each([
      [
        'a challenge whose price was edited after issue',
        (c: MutableCredential) => {
          c.challenge.request['amount'] = '1';
        },
        'challenge_not_issued',
      ],
      [
        'a challenge edited to another chain',
        (c: MutableCredential) => {
          c.challenge.request.methodDetails['chainId'] = 8453;
        },
        'challenge_not_issued',
      ],
      [
        'an authorization for another amount',
        (c: MutableCredential) => {
          c.payload['value'] = '1';
        },
        'wrong_amount',
      ],
      [
        'an authorization paying another recipient',
        (c: MutableCredential) => {
          c.payload['to'] = deployment.buyer.address;
        },
        'wrong_recipient',
      ],
      [
        'an authorization whose nonce is not the challenge hash',
        (c: MutableCredential) => {
          c.payload['nonce'] = `0x${'0'.repeat(64)}`;
        },
        'wrong_nonce',
      ],
    ])('%s', async (_label, change, reason) => {
      const { gateway } = await startGateway();
      const credential = altered(await mppCredential(gateway), change);
      await expectRefused(gateway, credential, invalid(reason));
    });

    it('an authorization signed by someone other than the payer it names', async () => {
      const { gateway } = await startGateway();
      const stranger = privateKeyToAccount(generatePrivateKey());
      const credential = altered(await mppCredential(gateway, { account: stranger }), (c) => {
        c.payload['from'] = deployment.buyer.address;
      });
      await expectRefused(gateway, credential, invalid('invalid_signature'));
    });

    it('an authorization signed for another token domain', async () => {
      const { gateway } = await startGateway();
      const credential = await mppCredential(gateway, { assetName: 'Other Token' });
      await expectRefused(gateway, credential, invalid('invalid_signature'));
    });

    it('a challenge for another deployed asset from a gateway sharing this secret', async () => {
      const otherToken = await deployLocalChain({
        rpcUrl: anvil.rpcUrl,
        buyerInitialBalance: '10.00',
      });
      expect(otherToken.asset).not.toBe(deployment.asset);
      const other = await startGateway({ mpp: { asset: otherToken.asset } });
      const { gateway } = await startGateway();
      await expectRefused(gateway, await mppCredential(other.gateway), invalid('wrong_asset'));
    });

    it('a challenge presented after it expired', async () => {
      const { gateway } = await startGateway({ mpp: { challengeTtlSeconds: 1 } });
      const credential = await mppCredential(gateway);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await expectRefused(gateway, credential, invalid('challenge_expired'));
    });
  });

  it('4. a credential presented twice settles once', async () => {
    const { gateway } = await startGateway();
    const credential = await mppCredential(gateway);
    const before = await balances();

    expect((await invoke(gateway, { authorization: credential })).statusCode).toBe(200);
    const replayed = await invoke(gateway, { authorization: credential });

    expect(replayed.statusCode).toBe(409);
    expect(replayed.body['code']).toBe('PAYMENT_REPLAYED');
    const after = await balances();
    expect(before.buyer - after.buyer).toBe(ONE_USDC);
    expect(after.merchant - before.merchant).toBe(ONE_USDC);
  });

  it('5. an unreachable settlement RPC refuses the payment and moves nothing', async () => {
    const { gateway } = await startGateway({ mpp: { rpcUrl: 'http://127.0.0.1:1' } });
    await expectRefused(gateway, await mppCredential(gateway), {
      statusCode: 502,
      code: 'PAYMENT_SETTLEMENT_FAILED',
      message: 'settlement_unavailable',
    });
  });

  it('6. a buyer with no funds is refused by the facilitator before broadcast', async () => {
    const { gateway } = await startGateway();
    const unfunded = privateKeyToAccount(generatePrivateKey());
    const refused = await expectRefused(
      gateway,
      await mppCredential(gateway, { account: unfunded }),
      {
        statusCode: 502,
        code: 'PAYMENT_SETTLEMENT_FAILED',
        message: 'invalid_exact_evm_transaction_simulation_failed',
      },
    );
    // A returned rejection, not an uncertain settlement
    expect(refused.body['details']).toBeUndefined();
  });

  it('7. a broadcast that is never confirmed is reported as uncertain, and the transfer lands once mined', async () => {
    const { gateway } = await startGateway();
    const credential = await mppCredential(gateway);
    const chain = createTestClient({ mode: 'anvil', transport: http(anvil.rpcUrl) });
    const before = await balances();
    const callsBefore = backendCalls;

    await chain.setAutomine(false);
    let uncertain: Invocation;
    let pending: Awaited<ReturnType<typeof balances>>;
    try {
      uncertain = await invoke(gateway, { authorization: credential });
      pending = await balances();
    } finally {
      // Re-enabling automine also mines what is pending
      await chain.setAutomine(true);
    }

    expect(uncertain.statusCode).toBe(502);
    expect(uncertain.body['code']).toBe('PAYMENT_SETTLEMENT_FAILED');
    const details = uncertain.body['details'] as Record<string, unknown>;
    expect(details['settlementUncertain']).toBe(true);
    expect(backendCalls).toBe(callsBefore);
    // Not "failed": the broadcast was pending, with nothing moved yet
    expect(pending).toEqual(before);

    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await balances(),
      amountBaseUnits: ONE_USDC,
      txHash: details['transactionHash'] as string,
    });
  }, 150_000);
});
