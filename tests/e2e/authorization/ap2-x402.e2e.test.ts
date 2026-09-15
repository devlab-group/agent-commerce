/**
 * An AP2-gated purchase settling on chain, through the whole gateway.
 *
 * The refusal matrix and the call counts are in
 * `tests/integration/ap2-x402-conformance.test.ts`. Here is what only a chain
 * shows: the coordinates a mandate commits to - destination, network, asset -
 * are the ones the x402 provider builds its challenge from, and a replayed
 * mandate moves no money. Balance deltas read back off the chain, never a log
 * line claiming success.
 *
 * The chain is an ephemeral Anvil this file spawns; the merchant backend is
 * stubbed, because what is under test is everything in front of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AP2_CHECKOUT_PROFILE } from '../../../src/authorization/ap2/constants.js';
import {
  type Ap2AuthorizationProvider,
  createAp2AuthorizationProvider,
} from '../../../src/authorization/ap2/index.js';
import { computeInputHash } from '../../../src/authorization/ap2/profile.js';
import { type GatewayConfig, parseConfig } from '../../../src/config/index.js';
import type { BackendExecutor, ReceiptStore } from '../../../src/core/index.js';
import { AUTHORIZATION_HEADER, PAYMENT_HEADER } from '../../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../../src/gateway/index.js';
import { createPaymentProof, createX402PaymentProvider } from '../../../src/payments/x402/index.js';
import {
  type AnvilHandle,
  deployLocalChain,
  startAnvil,
} from '../../../src/payments/x402/testing.js';
import { createSqliteReceiptStore } from '../../../src/storage/receipts/index.js';
import { expectRealSettlement, readBalances } from '../../fixtures/x402/settlement.js';
import {
  checkoutPayload,
  createParties,
  fixedClock,
  mintMandate,
  type Party,
  signCheckoutJwt,
} from '../../unit/authorization-ap2/fixtures.js';

const PORT = 18791;
const RESOURCE_ID = 'market_report';
const INPUT = { city: 'Berlin' };
const AMOUNT = '1.00';
const CURRENCY = 'USD';
const NETWORK = 'eip155:84532';

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let parties: Party;
let gateway: GatewayInstance;
let store: ReceiptStore;
let authorization: Ap2AuthorizationProvider;
let backendCalls = 0;

const backend: BackendExecutor = {
  async call() {
    backendCalls += 1;
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

function rawConfig(): Record<string, unknown> {
  const issuers = (entries: Party['mandateIssuers']) =>
    entries.map((entry) => ({
      issuer: entry.issuer,
      audience: entry.audience,
      keys: entry.keys.map((key) => ({ kid: key.kid, jwk: key.jwk })),
    }));
  return {
    version: 1,
    merchant: { id: 'ap2-e2e', name: 'AP2 E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Market report',
        input: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: AMOUNT, currency: CURRENCY },
        expose: ['http'],
        payments: ['x402'],
        authorization: { required: ['ap2'] },
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
        assetDecimals: deployment.assetDecimals,
        payTo: deployment.merchant.address,
        maxTimeoutSeconds: 120,
        facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
      },
    },
    authorization: {
      ap2: {
        enabled: true,
        specVersion: '0.2.0',
        mode: 'direct',
        trust: {
          mandateIssuers: issuers(parties.mandateIssuers),
          checkoutIssuers: issuers(parties.checkoutIssuers),
        },
        clockSkewSeconds: 60,
        replay: { path: ':memory:' },
      },
    },
  };
}

async function balances() {
  return readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: deployment.merchant.address,
  });
}

// A mandate approving exactly what the gateway's own x402 challenge asks for
async function mandateForChallenge(): Promise<string> {
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({
      agent_commerce: {
        profile: AP2_CHECKOUT_PROFILE,
        resource_id: RESOURCE_ID,
        input_hash: await computeInputHash(INPUT),
        amount: AMOUNT,
        currency: CURRENCY,
        payment_method: 'x402',
        destination: deployment.merchant.address,
        network: NETWORK,
        asset: deployment.asset,
      },
    }),
  );
  return mintMandate(parties.mandateSigner, jwt);
}

function carrier(presentation: string): string {
  return Buffer.from(JSON.stringify({ method: 'ap2', payload: presentation }), 'utf8').toString(
    'base64url',
  );
}

interface Invocation {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

async function invoke(headers: Record<string, string> = {}): Promise<Invocation> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: INPUT,
  });
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}

// Asks for the resource unpaid, then signs a proof against the challenge it returns
async function freshProof(): Promise<string> {
  const challenge = await invoke();
  expect(challenge.statusCode).toBe(402);
  const payment = challenge.body['payment'] as { accepts: Record<string, unknown>[] };
  return createPaymentProof({
    buyerPrivateKey: deployment.buyer.privateKey,
    rpcUrl: anvil.rpcUrl,
    accepts: payment.accepts[0] as Record<string, unknown>,
  });
}

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  parties = await createParties();

  const config: GatewayConfig = parseConfig(rawConfig(), process.env);
  const ap2 = config.authorization?.ap2;
  if (ap2 === undefined || !ap2.enabled) throw new Error('the fixture config must enable AP2');

  store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  authorization = createAp2AuthorizationProvider({ config: ap2, clock: fixedClock() });
  gateway = await createGateway({
    config,
    store,
    paymentProviders: [
      createX402PaymentProvider({
        network: NETWORK,
        rpcUrl: anvil.rpcUrl,
        asset: deployment.asset,
        assetName: deployment.assetName,
        assetVersion: deployment.assetVersion,
        assetDecimals: deployment.assetDecimals,
        payTo: deployment.merchant.address,
        facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
      }),
    ],
    authorizationProviders: [authorization],
    protocolAdapters: [],
    backend,
  });
}, 180_000);

afterAll(async () => {
  await gateway?.close().catch(() => {});
  authorization?.close();
  await store?.close().catch(() => {});
  await anvil?.stop();
});

describe('AP2-gated purchase over x402 - real local chain', () => {
  it('1. the 402 carries both the payment challenge and the mandate requirement', async () => {
    const challenge = await invoke();

    expect(challenge.statusCode).toBe(402);
    expect(challenge.body['authorization']).toEqual({
      required: [{ method: 'ap2', version: '0.2.0', profile: AP2_CHECKOUT_PROFILE }],
    });
    const payment = challenge.body['payment'] as Record<string, unknown>;
    // The three coordinates the mandate has to commit to are the ones the
    // challenge publishes, not values this test invented
    expect(payment['destination']).toBe(deployment.merchant.address);
    expect(payment['network']).toBe(NETWORK);
    expect(payment['asset']).toBe(deployment.asset);
  });

  it('2. a mandate matching that challenge settles on chain and delivers once', async () => {
    const proof = await freshProof();
    const presentation = await mandateForChallenge();
    const before = await balances();
    const callsBefore = backendCalls;

    const delivered = await invoke({
      [PAYMENT_HEADER]: proof,
      [AUTHORIZATION_HEADER]: carrier(presentation),
    });

    expect(delivered.statusCode).toBe(200);
    expect(backendCalls).toBe(callsBefore + 1);

    const receipts = await store.listReceipts({ limit: 5 });
    const receipt = receipts[0];
    expect(receipt?.authorization?.reference).toMatch(/^sha256:[\w-]+$/);
    const txHash = receipt?.payment?.externalReference;
    expect(txHash).toBeDefined();

    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await balances(),
      amountBaseUnits: 1_000_000n, // 1.00 at 6 decimals
      txHash: txHash as string,
    });
  });

  it('3. the same mandate with a fresh payment proof moves no second payment', async () => {
    const proof = await freshProof();
    const presentation = await mandateForChallenge();
    await invoke({
      [PAYMENT_HEADER]: proof,
      [AUTHORIZATION_HEADER]: carrier(presentation),
    });

    // A brand-new, perfectly good payment authorisation. Only the mandate is
    // reused, so nothing but the mandate can be what refuses this.
    const replayProof = await freshProof();
    const before = await balances();
    const callsBefore = backendCalls;

    const replayed = await invoke({
      [PAYMENT_HEADER]: replayProof,
      [AUTHORIZATION_HEADER]: carrier(presentation),
    });

    expect(replayed.statusCode).toBe(409);
    expect(replayed.body['code']).toBe('AUTHORIZATION_REPLAYED');
    expect(backendCalls).toBe(callsBefore);
    const after = await balances();
    expect(after.buyer).toBe(before.buyer);
    expect(after.merchant).toBe(before.merchant);
  });

  it('4. a mandate approved for a different amount settles nothing', async () => {
    const proof = await freshProof();
    const jwt = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({
        agent_commerce: {
          profile: AP2_CHECKOUT_PROFILE,
          resource_id: RESOURCE_ID,
          input_hash: await computeInputHash(INPUT),
          amount: '0.01',
          currency: CURRENCY,
          payment_method: 'x402',
          destination: deployment.merchant.address,
          network: NETWORK,
          asset: deployment.asset,
        },
      }),
    );
    const before = await balances();
    const callsBefore = backendCalls;

    const refused = await invoke({
      [PAYMENT_HEADER]: proof,
      [AUTHORIZATION_HEADER]: carrier(await mintMandate(parties.mandateSigner, jwt)),
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body['code']).toBe('AUTHORIZATION_INVALID');
    expect(backendCalls).toBe(callsBefore);
    const after = await balances();
    expect(after.buyer).toBe(before.buyer);
    expect(after.merchant).toBe(before.merchant);
  });
});
