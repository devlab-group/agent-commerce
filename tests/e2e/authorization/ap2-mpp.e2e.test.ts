/**
 * An AP2-gated purchase paid over MPP, settling on chain through the whole
 * gateway. It checks that a missing or mismatched mandate stops MPP settlement
 * the way `ap2-x402.e2e.test.ts` shows it stops x402 settlement.
 *
 * The chain is an ephemeral Anvil this file spawns; the merchant backend is
 * stubbed.
 */
import { Challenge } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AP2_CHECKOUT_PROFILE } from '../../../src/authorization/ap2/constants.js';
import {
  type Ap2AuthorizationProvider,
  createAp2AuthorizationProvider,
} from '../../../src/authorization/ap2/index.js';
import { computeInputHash } from '../../../src/authorization/ap2/profile.js';
import { parseConfig } from '../../../src/config/index.js';
import {
  AUTHORIZATION_HEADER,
  type BackendExecutor,
  NOOP_LOGGER,
  type ReceiptStore,
} from '../../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../../src/gateway/index.js';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers.js';
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

const PORT = 18793;
const RESOURCE_ID = 'market_report';
const INPUT = { city: 'Berlin' };
const AMOUNT = '1.00';
const CURRENCY = 'USDC';
const NETWORK = 'eip155:84532';

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

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
    merchant: { id: 'ap2-mpp-e2e', name: 'AP2 MPP E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
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
        payments: ['mpp'],
        authorization: { required: ['ap2'] },
      },
    },
    payments: {
      mpp: {
        enabled: true,
        rpcUrl: anvil.rpcUrl,
        asset: deployment.asset,
        assetName: deployment.assetName,
        assetVersion: deployment.assetVersion,
        recipient: deployment.merchant.address,
        realm: 'gateway.e2e',
        challengeSecret: 'ap2-mpp-e2e-challenge-secret'.padEnd(32, 'x'),
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

// A mandate approving the terms the 402 publishes, or the same terms for
// another payment method. AP2 compares these strings exactly, and the MPP
// provider publishes checksummed addresses.
async function mandate(paymentMethod = 'mpp'): Promise<string> {
  const payment = (await invoke()).body['payment'] as Record<string, string>;
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({
      agent_commerce: {
        profile: AP2_CHECKOUT_PROFILE,
        resource_id: RESOURCE_ID,
        input_hash: await computeInputHash(INPUT),
        amount: AMOUNT,
        currency: CURRENCY,
        payment_method: paymentMethod,
        destination: payment['destination'],
        network: payment['network'],
        asset: payment['asset'],
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
  readonly headers: Record<string, unknown>;
  readonly body: Record<string, unknown>;
}

async function invoke(headers: Record<string, string> = {}): Promise<Invocation> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: INPUT,
  });
  return { statusCode: res.statusCode, headers: res.headers, body: res.json() };
}

// Asks for the resource unpaid, then pays the MPP challenge with the mppx client
async function freshCredential(): Promise<string> {
  const challenged = await invoke();
  expect(challenged.statusCode).toBe(402);
  const challenge = Challenge.deserialize(String(challenged.headers['www-authenticate']));
  const client = clientCharge({
    account: privateKeyToAccount(deployment.buyer.privateKey),
    authorization: { name: deployment.assetName, version: deployment.assetVersion },
  });
  return String(
    await client.createCredential({ challenge: challenge as unknown as EvmChallenge, context: {} }),
  );
}

// Refused before settlement: no delivery and no balance change on chain
async function expectNothingSettled(
  headers: Record<string, string>,
  statusCode: number,
  code: string,
): Promise<void> {
  const before = await balances();
  const callsBefore = backendCalls;

  const refused = await invoke(headers);

  expect(refused.statusCode).toBe(statusCode);
  expect(refused.body['code']).toBe(code);
  expect(backendCalls).toBe(callsBefore);
  expect(await balances()).toEqual(before);
}

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  parties = await createParties();

  const config = parseConfig(rawConfig(), process.env);
  const ap2 = config.authorization?.ap2;
  if (ap2 === undefined || !ap2.enabled) throw new Error('the fixture config must enable AP2');

  store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  authorization = createAp2AuthorizationProvider({ config: ap2, clock: fixedClock() });
  gateway = await createGateway({
    config,
    store,
    paymentProviders: createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
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

describe('AP2-gated purchase over MPP - real local chain', () => {
  it('1. the 402 carries both the MPP challenge and the mandate requirement', async () => {
    const challenged = await invoke();

    expect(challenged.statusCode).toBe(402);
    expect(challenged.headers['www-authenticate']).toMatch(/^Payment /);
    expect(challenged.body['authorization']).toEqual({
      required: [{ method: 'ap2', version: '0.2.0', profile: AP2_CHECKOUT_PROFILE }],
    });
    const payment = challenged.body['payment'] as Record<string, unknown>;
    expect(payment).toMatchObject({
      provider: 'mpp',
      destination: getAddress(deployment.merchant.address),
      network: NETWORK,
      asset: getAddress(deployment.asset),
    });
  });

  it('2. a valid MPP credential without a mandate settles nothing', async () => {
    await expectNothingSettled(
      { authorization: await freshCredential() },
      403,
      'AUTHORIZATION_REQUIRED',
    );
  });

  it('3. a mandate approved for x402 settles nothing over MPP', async () => {
    await expectNothingSettled(
      {
        authorization: await freshCredential(),
        [AUTHORIZATION_HEADER]: carrier(await mandate('x402')),
      },
      403,
      'AUTHORIZATION_INVALID',
    );
  });

  it('4. a mandate matching the MPP challenge settles on chain and delivers once', async () => {
    const credential = await freshCredential();
    const before = await balances();
    const callsBefore = backendCalls;

    const delivered = await invoke({
      authorization: credential,
      [AUTHORIZATION_HEADER]: carrier(await mandate()),
    });

    expect(delivered.statusCode).toBe(200);
    expect(backendCalls).toBe(callsBefore + 1);
    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment?.provider).toBe('mpp');
    expect(receipt?.authorization?.reference).toMatch(/^sha256:[\w-]+$/);
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await balances(),
      amountBaseUnits: 1_000_000n, // 1.00 at 6 decimals
      txHash: receipt?.payment?.externalReference as string,
    });
  });

  it('5. the same mandate with a fresh MPP credential moves no second payment', async () => {
    const presentation = await mandate();
    await invoke({
      authorization: await freshCredential(),
      [AUTHORIZATION_HEADER]: carrier(presentation),
    });

    // A new, valid credential: only the mandate is reused
    await expectNothingSettled(
      { authorization: await freshCredential(), [AUTHORIZATION_HEADER]: carrier(presentation) },
      409,
      'AUTHORIZATION_REPLAYED',
    );
  });
});
