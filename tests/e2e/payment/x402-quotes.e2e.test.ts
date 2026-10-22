/**
 * A buyer checks ERC-8409 quotes before paying through the local facilitator.
 * The test starts and stops Anvil, deploys MockUSDC, and checks settlement
 * against on-chain balances and the transaction receipt. It uses no public
 * RPC endpoints or chains.
 */

import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import canonicalize from 'canonicalize';
import { type Hex, keccak256, recoverTypedDataAddress, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import { NOOP_LOGGER, type ReceiptStore } from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import type { SignedQuote } from '../../../src/payments/x402/provider/quote';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { expectRealSettlement, readBalances } from '../../fixtures/x402/settlement';

const PORT = 18795;
const RESOURCE_ID = 'quoted_report';
const INPUT = { symbol: 'ETH' };
const MAX_TIMEOUT_SECONDS = 120;
// Test-only quote signing key, never funded
const QUOTE_KEY = `0x${'33'.repeat(32)}` as const;

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let gateway: GatewayInstance;
let store: ReceiptStore;

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  const config = parseConfig(
    {
      version: 1,
      merchant: { id: 'quote-e2e', name: 'Quote E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
      server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        [RESOURCE_ID]: {
          name: 'Quoted report',
          input: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
            required: ['symbol'],
          },
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
          pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
        },
      },
      payments: {
        x402: {
          enabled: true,
          network: 'eip155:31337',
          rpcUrl: anvil.rpcUrl,
          asset: deployment.asset,
          assetName: deployment.assetName,
          assetVersion: deployment.assetVersion,
          assetDecimals: deployment.assetDecimals,
          payTo: deployment.merchant.address,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          facilitator: { mode: 'local', signerPrivateKey: deployment.facilitator.privateKey },
          quote: { enabled: true, signerPrivateKey: QUOTE_KEY },
        },
      },
    },
    {},
  );
  store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  gateway = await createGateway({
    config,
    store,
    paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [],
    backend: {
      async call() {
        return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
      },
    },
  });
}, 120_000);

afterAll(async () => {
  await gateway?.close().catch(() => {});
  await store?.close().catch(() => {});
  await anvil?.stop();
});

function invoke(headers: Record<string, string> = {}) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(INPUT),
  });
}

// ERC-8409 type fields, declared independently of the provider
const QUOTE_TYPES = {
  ServicePaymentQuote: [
    { name: 'issuer', type: 'address' },
    { name: 'payer', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'requestScheme', type: 'string' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'quoteId', type: 'bytes32' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

function quoteSigner({ chainId, quote, signature }: SignedQuote): Promise<Hex> {
  return recoverTypedDataAddress({
    domain: { name: 'Signed Service Payment Quotes', version: '1', chainId: Number(chainId) },
    types: QUOTE_TYPES,
    primaryType: 'ServicePaymentQuote',
    message: {
      ...quote,
      amount: BigInt(quote.amount),
      validAfter: BigInt(quote.validAfter),
      validUntil: BigInt(quote.validUntil),
    },
    signature,
  });
}

describe('x402 with ERC-8409 quotes - real local chain', () => {
  it('a buyer checks the quote against the well-known issuer, pays with the SDK client, and the payment settles', async () => {
    // 1. Read the issuer from the gateway's discovery document
    const wellKnown = (
      await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' })
    ).json();
    const issuer = wellKnown.payments.x402.quote.issuer as string;
    expect(issuer).toBe(privateKeyToAccount(QUOTE_KEY).address);

    // 2. The challenge carries one quote for the one EVM offer
    const challenged = await invoke();
    expect(challenged.statusCode).toBe(402);
    const buyer = privateKeyToAccount(deployment.buyer.privateKey);
    const payments = new x402Client();
    registerExactEvmScheme(payments, { signer: buyer, networks: ['eip155:31337'] });
    // MockUSDC is not in the SDK's spend-control asset list
    payments.setSpendControls(false);
    const http = new x402HTTPClient(payments);
    const required = http.getPaymentRequiredResponse(
      (name) => challenged.headers[name.toLowerCase()] as string | undefined,
    );
    const extension = required.extensions?.['erc-8409'] as { info: { quotes: SignedQuote[] } };
    const [signed] = extension.info.quotes;
    const [offer] = required.accepts;
    if (signed === undefined || offer === undefined) throw new Error('no quote or offer');

    // 3. Check the issuer, request hash, offer terms, and validity before paying
    const now = Math.floor(Date.now() / 1000);
    expect(await quoteSigner(signed)).toBe(issuer);
    expect(signed.quote).toMatchObject({
      issuer,
      payer: '0x0000000000000000000000000000000000000000',
      requestScheme: 'agent-commerce/request/v1',
      requestHash: keccak256(
        stringToBytes(canonicalize({ input: INPUT, resource: RESOURCE_ID }) as string),
      ),
      amount: offer.amount,
    });
    expect(signed.chainId).toBe('31337');
    expect(signed.quote.recipient.toLowerCase()).toBe(offer.payTo.toLowerCase());
    expect(signed.quote.asset.toLowerCase()).toBe(offer.asset.toLowerCase());
    expect(Number(signed.quote.validAfter)).toBeLessThanOrEqual(now);
    expect(Number(signed.quote.validUntil) - now).toBeGreaterThanOrEqual(MAX_TIMEOUT_SECONDS);

    // 4. The SDK echoes the extension; the gateway settles using the offer's terms
    const payload = await http.createPaymentPayload(required);
    expect(payload.extensions?.['erc-8409']).toEqual(extension);
    const before = await readBalances({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
    });

    const paid = await invoke(http.encodePaymentSignatureHeader(payload));

    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ report: 'ok' });
    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment).toMatchObject({ provider: 'x402', status: 'settled' });
    await expectRealSettlement({
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
      before,
      after: await readBalances({
        rpcUrl: anvil.rpcUrl,
        asset: deployment.asset,
        buyer: deployment.buyer.address,
        merchant: deployment.merchant.address,
      }),
      // The quoted amount, 1.00 at 6 decimals
      amountBaseUnits: BigInt(signed.quote.amount),
      txHash: receipt?.payment?.externalReference as string,
    });
    expect(signed.quote.amount).toBe('1000000');
  });
});
