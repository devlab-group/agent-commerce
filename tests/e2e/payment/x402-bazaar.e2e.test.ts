/**
 * Bazaar metadata during settlement on Anvil through a loopback facilitator.
 * Its recorded `/verify` and `/settle` bodies must use the challenge's
 * `resource` and `extensions.bazaar` when `payments.x402.bazaar` is enabled,
 * including when the buyer alters the echoed metadata. Each purchase must
 * move funds. With Bazaar disabled, or for MPP alongside Bazaar, the facilitator
 * payload contains only `x402Version`, `accepted` and `payload`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapMCPClientWithPayment } from '@x402/mcp';
import { Challenge } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type GatewayConfig, parseConfig } from '../../../src/config';
import {
  NOOP_LOGGER,
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createMcpAdapter } from '../../../src/protocols/mcp';
import { createSqliteReceiptStore, type SqliteReceiptStore } from '../../../src/storage/receipts';
import {
  type LoopbackBody,
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { expectRealSettlement, readBalances } from '../../fixtures/x402/settlement';

const PORT = 18801;
const NETWORK = 'eip155:31337';
const BASE = 'https://shop.example';
const INPUT = { city: 'Oslo' };
const ONE_USDC = 1_000_000n;
const THREE_KEYS = ['x402Version', 'accepted', 'payload'];

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

interface Stack {
  readonly gateway: GatewayInstance;
  readonly store: SqliteReceiptStore;
  readonly facilitator: LoopbackFacilitator;
  readonly url: string;
  readonly config: GatewayConfig;
}

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let withBazaar: Stack;
let withoutBazaar: Stack;
// Bazaar is enabled, but the facilitator does not advertise the extension
let unlisted: Stack;
let mcp: Client | undefined;

function rawConfig(facilitatorUrl: string, bazaar: boolean): Record<string, unknown> {
  const facilitator = { mode: 'remote', url: facilitatorUrl, auth: { type: 'none' } };
  const resource = (expose: string[], payments: string[]) => ({
    name: 'Forecast',
    description: 'Forecast for a city',
    input: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    backend: { type: 'http', method: 'POST', url: 'http://merchant.invalid/forecast' },
    pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
    expose,
    payments,
  });
  const domain = { assetName: deployment.assetName, assetVersion: deployment.assetVersion };
  return {
    version: 1,
    merchant: { id: 'bazaar-e2e', name: 'Bazaar E2E', publicBaseUrl: BASE },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
    resources: {
      forecast: resource(['http', 'mcp'], ['x402']),
      // MPP serves this resource because it is listed first; Bazaar metadata is omitted
      forecast_mpp: resource(['http'], ['mpp', 'x402']),
    },
    payments: {
      x402: {
        enabled: true,
        network: NETWORK,
        rpcUrl: anvil.rpcUrl,
        asset: deployment.asset,
        ...domain,
        assetDecimals: deployment.assetDecimals,
        payTo: deployment.merchant.address,
        maxTimeoutSeconds: 120,
        facilitator,
        ...(bazaar ? { publicResourceUrl: true, bazaar: { enabled: true } } : {}),
      },
      mpp: {
        enabled: true,
        network: NETWORK,
        rpcUrl: anvil.rpcUrl,
        asset: deployment.asset,
        ...domain,
        recipient: deployment.merchant.address,
        realm: 'shop.example',
        challengeSecret: 'bazaar-e2e-challenge-secret'.padEnd(32, 'x'),
        facilitator,
      },
    },
  };
}

async function startStack(bazaar: boolean, extensions: string[] = ['bazaar']): Promise<Stack> {
  const facilitator = await startLoopbackFacilitator({
    evm: {
      chains: [{ network: NETWORK, rpcUrl: anvil.rpcUrl }],
      signerPrivateKey: deployment.facilitator.privateKey,
    },
    extensions,
  });
  const config = parseConfig(rawConfig(facilitator.url, bazaar), {});
  const store = createSqliteReceiptStore({ path: ':memory:', logger: NOOP_LOGGER });
  await store.init();
  const gateway = await createGateway({
    config,
    store,
    paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [createMcpAdapter()],
    logger: NOOP_LOGGER,
    backend: {
      async call() {
        return { status: 200, body: { forecast: 'sun' }, headers: {}, durationMs: 1 };
      },
    },
  });
  const { url } = await gateway.listen();
  return { gateway, store, facilitator, url, config };
}

function invoke(stack: Stack, id: string, headers: Record<string, string> = {}) {
  return stack.gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${id}/invoke`,
    headers: { host: new URL(BASE).host, 'content-type': 'application/json', ...headers },
    payload: INPUT,
  });
}

const decode = (value: unknown): Record<string, unknown> =>
  JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));

const encode = (proof: PaymentPayload) => Buffer.from(JSON.stringify(proof)).toString('base64');

function buyer(): x402Client {
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(deployment.buyer.privateKey),
    networks: [NETWORK],
  });
  client.setSpendControls(false);
  return client;
}

async function httpChallenge(stack: Stack): Promise<PaymentRequired> {
  const unpaid = await invoke(stack, 'forecast');
  expect(unpaid.statusCode).toBe(402);
  return decode(unpaid.headers[PAYMENT_REQUIRED_HEADER]) as unknown as PaymentRequired;
}

function balances() {
  return readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: deployment.merchant.address,
  });
}

// Run a purchase, verify its balance changes and receipt transaction, then
// return the facilitator request bodies it produced
async function purchase(
  stack: Stack,
  pay: () => Promise<void>,
  provider: 'x402' | 'mpp' = 'x402',
): Promise<LoopbackBody[]> {
  const from = stack.facilitator.bodies.length;
  const before = await balances();

  await pay();

  const [receipt] = await stack.store.listReceipts({ limit: 1 });
  expect(receipt?.payment).toMatchObject({ provider, status: 'settled' });
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
  return stack.facilitator.bodies.slice(from);
}

async function payHttp(stack: Stack, proof: PaymentPayload): Promise<string> {
  const paid = await invoke(stack, 'forecast', { [PAYMENT_HEADER]: encode(proof) });
  expect(paid.statusCode).toBe(200);
  expect(paid.json()).toEqual({ forecast: 'sun' });
  return String(decode(paid.headers[PAYMENT_RESPONSE_HEADER])['transaction']);
}

const payloads = (bodies: LoopbackBody[]) => bodies.map(({ body }) => body['paymentPayload']);

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '10.00' });
  withBazaar = await startStack(true);
  withoutBazaar = await startStack(false);
  unlisted = await startStack(true, []);
}, 180_000);

afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
});

afterAll(async () => {
  for (const stack of [withBazaar, withoutBazaar, unlisted]) {
    await stack?.gateway.close().catch(() => {});
    await stack?.store.close().catch(() => {});
    await stack?.facilitator.close();
  }
  await anvil?.stop();
});

describe('x402 Bazaar metadata - real local chain', () => {
  it('HTTP: settles, and the facilitator verifies and settles with the 402 resource and metadata', async () => {
    const required = await httpChallenge(withBazaar);
    expect(required.resource.url).toBe(`${BASE}/api/resources/forecast/invoke`);
    expect(Object.keys(required.extensions ?? {})).toEqual(['bazaar']);
    const proof = await buyer().createPaymentPayload(required);
    let transaction = '';

    const bodies = await purchase(withBazaar, async () => {
      transaction = await payHttp(withBazaar, proof);
    });

    expect(bodies.map(({ operation }) => operation)).toEqual(['verify', 'settle']);
    for (const payload of payloads(bodies)) {
      expect(payload).toEqual({
        x402Version: 2,
        accepted: required.accepts[0],
        payload: proof.payload,
        resource: required.resource,
        extensions: { bazaar: required.extensions?.['bazaar'] },
      });
    }
    const [receipt] = await withBazaar.store.listReceipts({ limit: 1 });
    expect(receipt?.payment?.externalReference).toBe(transaction);
  });

  it('HTTP: an altered echo changes nothing the facilitator receives', async () => {
    const required = await httpChallenge(withBazaar);
    const proof = await buyer().createPaymentPayload(required);
    const altered: PaymentPayload = {
      ...proof,
      resource: {
        ...(proof.resource as PaymentRequired['resource']),
        description: 'Free money',
      },
      extensions: {
        bazaar: { info: { input: { type: 'http', body: { poisoned: true } } } },
        'payment-identifier': { info: { id: 'pay_1234567890abcdef' } },
        eip2612GasSponsoring: { info: { signature: '0x00' } },
      },
    };

    const bodies = await purchase(withBazaar, async () => {
      await payHttp(withBazaar, altered);
    });

    expect(bodies.map(({ operation }) => operation)).toEqual(['verify', 'settle']);
    for (const payload of payloads(bodies)) {
      expect(payload).toEqual({
        x402Version: 2,
        accepted: required.accepts[0],
        payload: proof.payload,
        resource: required.resource,
        extensions: { bazaar: required.extensions?.['bazaar'] },
      });
    }
  });

  it('MCP: an @x402/mcp client settles, and the facilitator gets the MCP challenge metadata', async () => {
    mcp = new Client({ name: 'bazaar-e2e-buyer', version: '0.0.0-test' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${withBazaar.url}/mcp`)) as Transport,
    );
    const challenged = (await mcp.callTool({
      name: 'forecast',
      arguments: INPUT,
    })) as CallToolResult;
    const required = challenged.structuredContent as unknown as PaymentRequired;
    expect(required.resource.url).toBe(`${BASE}/mcp`);
    expect(Object.keys(required.extensions ?? {})).toEqual(['bazaar']);

    const bodies = await purchase(withBazaar, async () => {
      const result = await wrapMCPClientWithPayment(mcp as Client, buyer(), {
        autoPayment: true,
      }).callTool('forecast', INPUT);
      expect(result.paymentMade).toBe(true);
      expect(result.isError).not.toBe(true);
    });

    expect(bodies.map(({ operation }) => operation)).toEqual(['verify', 'settle']);
    for (const payload of payloads(bodies) as Record<string, unknown>[]) {
      expect(Object.keys(payload)).toEqual([...THREE_KEYS, 'resource', 'extensions']);
      expect(payload['resource']).toEqual(required.resource);
      expect(payload['extensions']).toEqual({ bazaar: required.extensions?.['bazaar'] });
    }
  });

  it('feature off: settles with only x402Version, accepted and payload sent', async () => {
    const required = await httpChallenge(withoutBazaar);
    expect(required).not.toHaveProperty('extensions');
    const proof = await buyer().createPaymentPayload(required);

    const bodies = await purchase(withoutBazaar, async () => {
      await payHttp(withoutBazaar, proof);
    });

    expect(bodies.map(({ operation }) => operation)).toEqual(['verify', 'settle']);
    for (const payload of payloads(bodies) as Record<string, unknown>[]) {
      expect(Object.keys(payload)).toEqual(THREE_KEYS);
    }
  });

  it('facilitator without the extension: settles with the metadata in the 402 and none sent', async () => {
    const required = await httpChallenge(unlisted);
    expect(Object.keys(required.extensions ?? {})).toEqual(['bazaar']);
    const proof = await buyer().createPaymentPayload(required);

    const bodies = await purchase(unlisted, async () => {
      await payHttp(unlisted, proof);
    });

    expect(unlisted.facilitator.requests).toContain('GET /supported');
    expect(bodies.map(({ operation }) => operation)).toEqual(['verify', 'settle']);
    for (const payload of payloads(bodies) as Record<string, unknown>[]) {
      expect(Object.keys(payload)).toEqual(THREE_KEYS);
    }
  });

  it('MPP beside Bazaar: settles with only x402Version, accepted and payload sent', async () => {
    // Config omits the x402 URL and metadata because MPP serves this resource
    expect(withBazaar.config.payments.x402?.resourceBazaar).not.toHaveProperty('forecast_mpp');
    expect(withBazaar.config.payments.x402?.resourceUrls).not.toHaveProperty('forecast_mpp');
    const bodies = await purchase(
      withBazaar,
      async () => {
        const unpaid = await invoke(withBazaar, 'forecast_mpp');
        expect(unpaid.statusCode).toBe(402);
        expect(unpaid.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
        const challenge = Challenge.deserialize(String(unpaid.headers['www-authenticate']));
        const credential = await clientCharge({
          account: privateKeyToAccount(deployment.buyer.privateKey),
          authorization: { name: deployment.assetName, version: deployment.assetVersion },
        }).createCredential({ challenge: challenge as unknown as EvmChallenge, context: {} });

        const paid = await invoke(withBazaar, 'forecast_mpp', {
          authorization: String(credential),
        });

        expect(paid.statusCode).toBe(200);
      },
      'mpp',
    );

    expect(bodies.map(({ operation }) => operation)).toEqual(['verify', 'settle']);
    for (const payload of payloads(bodies) as Record<string, unknown>[]) {
      expect(Object.keys(payload)).toEqual(THREE_KEYS);
    }
  });
});
