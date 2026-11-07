/**
 * Test paid retries on local Anvil with the gateway, a merchant HTTP server
 * and MockUSDC. Simulate response loss by closing the buyer's socket after the
 * merchant receives the request. The gateway ignores the disconnect and finishes
 * the purchase; the buyer retries with the same payment identifier. x402 and MPP
 * use a loopback facilitator behind a holding proxy. Each case checks on-chain
 * balances; charged cases also verify the receipt's transaction on-chain.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { Challenge, Receipt } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import {
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  maxUint256,
  publicActions,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil as anvilChain } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReconcileCommand } from '../../../src/cli/commands/reconcile';
import { type GatewayConfig, parseConfig } from '../../../src/config';
import {
  type CommerceReceipt,
  NOOP_LOGGER,
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from '../../../src/core';
import { createGateway } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createPaymentProof } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore, type SqliteReceiptStore } from '../../../src/storage/receipts';
import { type HoldingProxy, startHoldingProxy } from '../../fixtures/x402/holding-proxy';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { installMulticall3, installPermit2 } from '../../fixtures/x402/permit2-contracts';
import {
  assertBalanceDelta,
  type BalanceSnapshot,
  expectRealSettlement,
  readBalances,
} from '../../fixtures/x402/settlement';
import { createCapturingIo } from '../../unit/cli/fixtures';

const PORT = 18800;
const NETWORK = 'eip155:31337';
const INPUT = { city: 'Berlin' };
const ONE_USDC = 1_000_000n;
// x402's payment identifier and MPP's Idempotency-Key
const ID = 'purchase-0123456789abcdef';
const KEY = 'order-42-retry';
const SECRET = 'retry-e2e-challenge-secret'.padEnd(32, 'x');
// Redelivery must retain the merchant's first response (call 1)
const STORED = { report: 'ok', call: 1 };
// Mine past Anvil's finality lag
const FINALITY_BLOCKS = 65;

type Flow = 'upfront' | 'authorization';
// x402 EIP-3009 or Permit2; MPP EIP-3009
type Rail = 'x402' | 'permit2' | 'mpp';
type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let merchantServer: Server;
let merchantUrl: string;
const cleanups: (() => Promise<void>)[] = [];

// Record the Idempotency-Key and return the call number after any pause
const merchant = {
  keys: [] as (string | undefined)[],
  status: 200,
  pause: undefined as (() => Promise<void>) | undefined,
};

interface Env {
  readonly rail: Rail;
  readonly config: GatewayConfig;
  readonly receipts: string;
  // Between the gateway and the facilitator
  readonly front: HoldingProxy;
  readonly facilitator: LoopbackFacilitator;
}

interface Invocation {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  json(): Record<string, unknown>;
}

interface Gateway {
  readonly rail: Rail;
  readonly url: string;
  readonly store: SqliteReceiptStore;
  invoke(flow: Flow, headers?: Record<string, string>): Promise<Invocation>;
  close(): Promise<void>;
}

interface ReconcileJson {
  readonly entries: readonly {
    readonly outcome: string;
    readonly reason: string;
    readonly written: boolean;
  }[];
}

function rawConfig(dir: string, facilitatorUrl: string, rail: Rail): Record<string, unknown> {
  const resource = (flow: Flow) => ({
    name: `Report, ${flow} flow`,
    input: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    backend: { type: 'http', method: 'POST', url: `${merchantUrl}/report`, timeoutMs: 60_000 },
    pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
    expose: ['http'],
    payments: [rail === 'mpp' ? 'mpp' : 'x402'],
    paymentFlow: flow,
    idempotency: { merchantKey: true, redelivery: { retentionHours: 24 } },
  });
  const facilitator = { mode: 'remote', url: facilitatorUrl, auth: { type: 'none' } };
  const domain = { assetName: deployment.assetName, assetVersion: deployment.assetVersion };
  const payments =
    rail === 'mpp'
      ? {
          mpp: {
            enabled: true,
            network: NETWORK,
            rpcUrl: anvil.rpcUrl,
            asset: deployment.asset,
            ...domain,
            recipient: deployment.merchant.address,
            realm: 'retry.e2e',
            challengeSecret: SECRET,
            facilitator,
          },
        }
      : {
          x402: {
            enabled: true,
            network: NETWORK,
            rpcUrl: anvil.rpcUrl,
            asset: deployment.asset,
            // Permit2 offers omit the token domain because the buyer signs Permit2's domain
            ...(rail === 'permit2' ? { assetTransferMethod: 'permit2' } : domain),
            assetDecimals: deployment.assetDecimals,
            payTo: deployment.merchant.address,
            maxTimeoutSeconds: 60,
            facilitator,
          },
        };
  return {
    version: 1,
    merchant: { id: 'retry-e2e', name: 'Retry E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: join(dir, 'receipts.sqlite') } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      report_upfront: resource('upfront'),
      report_authorization: resource('authorization'),
    },
    payments,
  };
}

async function stack(rail: Rail = 'x402'): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'oac-retry-e2e-'));
  const facilitator = await startLoopbackFacilitator({
    evm: {
      chains: [{ network: NETWORK, rpcUrl: anvil.rpcUrl }],
      signerPrivateKey: deployment.facilitator.privateKey,
    },
  });
  const front = await startHoldingProxy(facilitator.url);
  cleanups.push(async () => {
    await front.close();
    await facilitator.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    rail,
    config: parseConfig(rawConfig(dir, front.url, rail), {}),
    receipts: join(dir, 'receipts.sqlite'),
    front,
    facilitator,
  };
}

// Start a gateway on a TCP socket using the environment's receipt database
async function startGateway(env: Env): Promise<Gateway> {
  const store = createSqliteReceiptStore({ path: env.receipts, logger: NOOP_LOGGER });
  await store.init();
  const gateway = await createGateway({
    config: env.config,
    store,
    paymentProviders: await createConfiguredPaymentProviders(env.config.payments, NOOP_LOGGER),
    protocolAdapters: [],
    logger: NOOP_LOGGER,
  });
  const { url } = await gateway.listen();
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= gateway.close().then(() => store.close());
    return closing;
  };
  cleanups.push(close);
  return {
    rail: env.rail,
    url,
    store,
    invoke: (flow, headers = {}) =>
      gateway.server.inject({
        method: 'POST',
        url: `/api/resources/report_${flow}/invoke`,
        headers: { 'content-type': 'application/json', ...headers },
        payload: INPUT,
      }),
    close,
  };
}

const decode = (value: unknown): Record<string, unknown> =>
  JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));

// Answer a fresh challenge with ID for x402 or KEY for MPP
async function paidHeaders(gateway: Gateway, flow: Flow): Promise<Record<string, string>> {
  const unpaid = await gateway.invoke(flow);
  expect(unpaid.statusCode).toBe(402);
  if (gateway.rail === 'mpp') {
    const challenge = Challenge.deserialize(String(unpaid.headers['www-authenticate']));
    const client = clientCharge({
      account: privateKeyToAccount(deployment.buyer.privateKey),
      authorization: { name: deployment.assetName, version: deployment.assetVersion },
    });
    const credential = await client.createCredential({
      challenge: challenge as unknown as EvmChallenge,
      context: {},
    });
    return { authorization: String(credential), 'idempotency-key': KEY };
  }
  const required = decode(unpaid.headers[PAYMENT_REQUIRED_HEADER]) as unknown as PaymentRequired;
  const declared = required.extensions?.['payment-identifier'] as { info: object };
  const extensions = {
    ...required.extensions,
    'payment-identifier': { ...declared, info: { ...declared.info, id: ID } },
  };
  if (gateway.rail === 'x402') {
    const proof = await createPaymentProof({
      buyerPrivateKey: deployment.buyer.privateKey,
      accepts: required.accepts[0] as unknown as Record<string, unknown>,
      extensions,
    });
    return { [PAYMENT_HEADER]: proof };
  }
  // Use the SDK for Permit2 and echoed extensions; createPaymentProof supports EIP-3009 only
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(deployment.buyer.privateKey),
    networks: [NETWORK],
  });
  client.setSpendControls(false);
  const payload = await client.createPaymentPayload({ ...required, extensions });
  return { [PAYMENT_HEADER]: Buffer.from(JSON.stringify(payload)).toString('base64') };
}

// Drop the buyer's socket after the merchant receives the request. Wait for
// resource.delivered, emitted after the receipt and response writes.
async function loseResponse(
  gateway: Gateway,
  flow: Flow,
  headers: Record<string, string>,
): Promise<void> {
  const request = httpRequest(`${gateway.url}/api/resources/report_${flow}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
  let answered = false;
  request.on('response', () => {
    answered = true;
  });
  // Destroying the socket raises ECONNRESET on the request
  request.on('error', () => {});
  const closed = new Promise<void>((resolve) => request.on('close', resolve));
  merchant.pause = async () => {
    request.destroy();
    await closed;
  };
  request.end(JSON.stringify(INPUT));
  await closed;
  expect(answered).toBe(false);
  await vi.waitFor(
    async () => {
      const events = await gateway.store.listEvents({ limit: 100 });
      expect(events.filter((event) => event.type === 'resource.delivered')).toHaveLength(1);
    },
    { timeout: 30_000, interval: 50 },
  );
  merchant.pause = undefined;
}

function balances(): Promise<BalanceSnapshot> {
  return readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: deployment.merchant.address,
  });
}

// Require exactly one receipt with a settled payment
async function settledReceipt(store: SqliteReceiptStore): Promise<CommerceReceipt> {
  const settled = (await store.listReceipts()).filter(
    (receipt) => receipt.payment?.status === 'settled',
  );
  expect(settled).toHaveLength(1);
  return settled[0] as CommerceReceipt;
}

// Verify one transfer of the price since before; return the receipt's transaction hash
async function expectOneCharge(before: BalanceSnapshot, store: SqliteReceiptStore) {
  const txHash = (await settledReceipt(store)).payment?.externalReference ?? '';
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
  return txHash;
}

const settleCalls = (env: Env) =>
  env.facilitator.requests.filter((line) => line === 'POST /settle').length;

function expectRedelivered(response: Invocation, txHash: string): void {
  expect(response.statusCode).toBe(200);
  expect(response.headers['idempotent-replayed']).toBe('true');
  expect(response.json()).toEqual(STORED);
  expect(decode(response.headers[PAYMENT_RESPONSE_HEADER])).toMatchObject({
    success: true,
    transaction: txHash,
  });
}

function expectUnresolved(response: Invocation): void {
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({
    code: 'PAYMENT_REPLAYED',
    retryable: false,
    details: { reason: 'payment_identifier_unresolved' },
  });
  expect(response.headers['retry-after']).toBeUndefined();
  expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
}

function testClient() {
  return createTestClient({ mode: 'anvil', transport: http(anvil.rpcUrl) });
}

function buyerWallet() {
  return createWalletClient({
    account: privateKeyToAccount(deployment.buyer.privateKey),
    chain: anvilChain,
    transport: http(anvil.rpcUrl),
  }).extend(publicActions);
}

// Mine from payment expiry through finality, run reconcile, then restore the chain
async function reconcileExpired(env: Env): Promise<ReconcileJson> {
  const store = createSqliteReceiptStore({ path: env.receipts, logger: NOOP_LOGGER });
  await store.init();
  const page = await store.listTransactions();
  await store.close();
  expect(page.transactions).toHaveLength(1);
  const expiresAt = page.transactions[0]?.payment.expiresAt ?? '';
  const snapshot = await testClient().snapshot();
  try {
    await testClient().setNextBlockTimestamp({ timestamp: BigInt(Date.parse(expiresAt) / 1000) });
    await testClient().mine({ blocks: FINALITY_BLOCKS });
    const io = createCapturingIo();
    const code = await runReconcileCommand({ json: true, actor: 'retry-e2e', minAge: '0' }, io, {
      loadConfig: async () => env.config,
    });
    expect(io.err).toEqual([]);
    expect(code).toBe(0);
    return JSON.parse(io.out.join('\n')) as ReconcileJson;
  } finally {
    await testClient().revert({ id: snapshot });
  }
}

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  await installMulticall3(anvil.rpcUrl);
  await installPermit2(anvil.rpcUrl);
  merchantServer = createServer(async (request, response) => {
    for await (const _ of request);
    const key = request.headers['idempotency-key'];
    merchant.keys.push(typeof key === 'string' ? key : undefined);
    const call = merchant.keys.length;
    await merchant.pause?.();
    response.writeHead(merchant.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ report: 'ok', call }));
  });
  await new Promise<void>((resolve) => merchantServer.listen(0, '127.0.0.1', resolve));
  merchantUrl = `http://127.0.0.1:${(merchantServer.address() as AddressInfo).port}`;
}, 180_000);

beforeEach(() => {
  merchant.keys = [];
  merchant.status = 200;
  merchant.pause = undefined;
});

afterEach(async () => {
  // Close gateways before the stack they use
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  merchantServer?.closeAllConnections();
  await new Promise((resolve) => merchantServer?.close(resolve));
  await anvil?.stop();
});

describe('a retry after a lost response', () => {
  it.each([
    ['authorization', 'an exact resend'],
    ['authorization', 'a fresh proof'],
    ['upfront', 'an exact resend'],
    ['upfront', 'a fresh proof'],
  ] as const)(
    '%s flow: %s gets the stored response and the buyer is charged once',
    async (flow, style) => {
      const env = await stack();
      const gateway = await startGateway(env);
      const headers = await paidHeaders(gateway, flow);
      const before = await balances();

      await loseResponse(gateway, flow, headers);
      const txHash = await expectOneCharge(before, gateway.store);
      const retry = style === 'an exact resend' ? headers : await paidHeaders(gateway, flow);
      const response = await gateway.invoke(flow, retry);

      expectRedelivered(response, txHash);
      expect(merchant.keys).toHaveLength(1);
      expect(settleCalls(env)).toBe(1);
      assertBalanceDelta(before, await balances(), ONE_USDC);
    },
  );

  it('redelivers a Permit2 exact resend with one charge', async () => {
    const wallet = buyerWallet();
    const approval = await wallet.writeContract({
      address: deployment.asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    });
    await wallet.waitForTransactionReceipt({ hash: approval });
    const env = await stack('permit2');
    const gateway = await startGateway(env);
    const headers = await paidHeaders(gateway, 'authorization');
    expect(decode(headers[PAYMENT_HEADER])).toMatchObject({
      accepted: { extra: { assetTransferMethod: 'permit2' } },
      extensions: { 'payment-identifier': { info: { id: ID } } },
    });
    const before = await balances();

    await loseResponse(gateway, 'authorization', headers);
    const txHash = await expectOneCharge(before, gateway.store);
    const response = await gateway.invoke('authorization', headers);

    expectRedelivered(response, txHash);
    expect(merchant.keys).toHaveLength(1);
    expect(settleCalls(env)).toBe(1);
    assertBalanceDelta(before, await balances(), ONE_USDC);
  });

  it('redelivers an MPP exact resend with its Idempotency-Key and one charge', async () => {
    const env = await stack('mpp');
    const gateway = await startGateway(env);
    const headers = await paidHeaders(gateway, 'upfront');
    const before = await balances();

    await loseResponse(gateway, 'upfront', headers);
    const txHash = await expectOneCharge(before, gateway.store);
    const response = await gateway.invoke('upfront', headers);

    expectRedelivered(response, txHash);
    expect(Receipt.deserialize(String(response.headers['payment-receipt']))).toMatchObject({
      reference: txHash,
      status: 'success',
    });
    expect(merchant.keys).toHaveLength(1);
    expect(settleCalls(env)).toBe(1);
    assertBalanceDelta(before, await balances(), ONE_USDC);
  });
});

describe('one payment identifier across requests', () => {
  it('settles two concurrent proofs with one ID once, then redelivers to the refused request', async () => {
    const env = await stack();
    const gateway = await startGateway(env);
    const proofs = [
      await paidHeaders(gateway, 'authorization'),
      await paidHeaders(gateway, 'authorization'),
    ];
    const before = await balances();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the claim owner's backend call so the other request sees an in-flight key
    merchant.pause = () => released;

    const requests = proofs.map((headers) => gateway.invoke('authorization', headers));
    const busy = await Promise.race(requests);
    release();
    const responses = await Promise.all(requests);

    expect(busy.statusCode).toBe(409);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.json()).toMatchObject({
      code: 'PAYMENT_REPLAYED',
      retryable: true,
      details: { reason: 'payment_identifier_in_flight' },
    });
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const txHash = await expectOneCharge(before, gateway.store);
    const waited = proofs[responses.indexOf(busy)] as Record<string, string>;
    expectRedelivered(await gateway.invoke('authorization', waited), txHash);
    expect(merchant.keys).toHaveLength(1);
    expect(settleCalls(env)).toBe(1);
    assertBalanceDelta(before, await balances(), ONE_USDC);
  });

  it('reuses the merchant key for a re-signed retry after authorization backend failure, charging once', async () => {
    const env = await stack();
    const gateway = await startGateway(env);
    const before = await balances();
    merchant.status = 503;

    const failed = await gateway.invoke(
      'authorization',
      await paidHeaders(gateway, 'authorization'),
    );
    expect(failed.statusCode).toBe(502);
    expect(await balances()).toEqual(before);
    merchant.status = 200;
    const paid = await gateway.invoke('authorization', await paidHeaders(gateway, 'authorization'));

    expect(paid.statusCode).toBe(200);
    expect(paid.headers['idempotent-replayed']).toBeUndefined();
    expect(paid.json()).toEqual({ report: 'ok', call: 2 });
    await expectOneCharge(before, gateway.store);
    expect(merchant.keys).toHaveLength(2);
    expect(merchant.keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(merchant.keys[1]).toBe(merchant.keys[0]);
    expect(settleCalls(env)).toBe(1);
  });

  it('returns 409 without a challenge for both retry styles after a settled upfront purchase fails delivery, charging once', async () => {
    const env = await stack();
    const gateway = await startGateway(env);
    const headers = await paidHeaders(gateway, 'upfront');
    const before = await balances();
    merchant.status = 503;

    const failed = await gateway.invoke('upfront', headers);
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: 'BACKEND_ERROR' });
    const txHash = await expectOneCharge(before, gateway.store);
    expect(decode(failed.headers[PAYMENT_RESPONSE_HEADER])).toMatchObject({
      success: true,
      transaction: txHash,
    });
    merchant.status = 200;

    expectUnresolved(await gateway.invoke('upfront', headers));
    expectUnresolved(await gateway.invoke('upfront', await paidHeaders(gateway, 'upfront')));
    expect(merchant.keys).toHaveLength(1);
    expect(settleCalls(env)).toBe(1);
    assertBalanceDelta(before, await balances(), ONE_USDC);
  });

  it('redelivers an exact resend from an emptied wallet but rejects a fresh proof with 402 and no charge', async () => {
    const env = await stack();
    const gateway = await startGateway(env);
    const headers = await paidHeaders(gateway, 'authorization');
    const before = await balances();
    expect((await gateway.invoke('authorization', headers)).statusCode).toBe(200);
    const txHash = await expectOneCharge(before, gateway.store);
    const fresh = await paidHeaders(gateway, 'authorization');
    const snapshot = await testClient().snapshot();
    try {
      const wallet = buyerWallet();
      const drain = await wallet.writeContract({
        address: deployment.asset,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [privateKeyToAccount(generatePrivateKey()).address, (await balances()).buyer],
      });
      await wallet.waitForTransactionReceipt({ hash: drain });
      const drained = await balances();
      expect(drained.buyer).toBe(0n);

      const resend = await gateway.invoke('authorization', headers);
      const refused = await gateway.invoke('authorization', fresh);

      expectRedelivered(resend, txHash);
      expect(refused.statusCode).toBe(402);
      expect(refused.json()).toMatchObject({ code: 'PAYMENT_INVALID' });
      expect(refused.headers[PAYMENT_REQUIRED_HEADER]).toEqual(expect.any(String));
      expect(await balances()).toEqual(drained);
      expect(merchant.keys).toHaveLength(1);
      expect(settleCalls(env)).toBe(1);
    } finally {
      await testClient().revert({ id: snapshot });
    }
  });
});

describe('a restart during settlement', () => {
  it('keeps the ID unresolved before and after reconcile: both retry styles get 409 without settlement', async () => {
    const env = await stack();
    const first = await startGateway(env);
    const headers = await paidHeaders(first, 'upfront');
    const before = await balances();
    const held = env.front.hold((path) => path === '/settle', { forward: false });

    // Keep /settle blocked until cleanup. Close the old store before restarting to prevent later writes.
    void first.invoke('upfront', headers).catch(() => {});
    await held;
    await first.close();
    const second = await startGateway(env);

    expect((await second.store.summary({ orphanHoldMinAgeMs: 0 })).unresolvedPaymentKeys).toBe(1);
    expectUnresolved(await second.invoke('upfront', headers));
    expectUnresolved(await second.invoke('upfront', await paidHeaders(second, 'upfront')));
    await second.close();
    const report = await reconcileExpired(env);
    expect(report.entries).toEqual([
      expect.objectContaining({ outcome: 'not-settled', reason: 'expired_unused', written: true }),
    ]);
    const third = await startGateway(env);
    expectUnresolved(await third.invoke('upfront', headers));
    expectUnresolved(await third.invoke('upfront', await paidHeaders(third, 'upfront')));

    expect(settleCalls(env)).toBe(0);
    expect(await balances()).toEqual(before);
    expect(merchant.keys).toEqual([]);
  });
});
