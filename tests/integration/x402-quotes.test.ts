/**
 * HTTP, MCP, and A2A carry the same ERC-8409 quotes through a gateway built
 * from parsed config. A buyer can recompute the request hash, recover the
 * published issuer, and submit an SDK payment that echoes the quote extension.
 * Settlement uses a mocked facilitator HTTP client; the receipt store is a
 * fake, and the backend is a stub.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import canonicalize from 'canonicalize';
import { type Hex, keccak256, recoverTypedDataAddress, stringToBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config';
import { NOOP_LOGGER, PAYMENT_REQUIRED_HEADER } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers';
import type { SignedQuote } from '../../src/payments/x402/provider/quote';
import { createA2aAdapter } from '../../src/protocols/a2a';
import type { A2aTask } from '../../src/protocols/a2a/types';
import { A2A_X402_EXTENSION_URI } from '../../src/protocols/a2a/x402-extension';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createFakeStore } from '../unit/gateway/helpers';

process.env['NODE_ENV'] = 'test';

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('@x402/core/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@x402/core/http')>()),
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitator.verify(...args);
    }
    settle(...args: unknown[]) {
      return facilitator.settle(...args);
    }
  },
}));

// Test-only key, never funded
const QUOTE_KEY = `0x${'33'.repeat(32)}`;
const PAY_TO = '0x1111111111111111111111111111111111111111';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RESOURCE_ID = 'quoted_report';
const INPUT = { symbol: 'ETH' };
const TX = `0x${'ef'.repeat(32)}`;
const buyer = privateKeyToAccount(generatePrivateKey());

let gateway: GatewayInstance;
let url = '';
const clients: Client[] = [];

beforeEach(async () => {
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true, payer: buyer.address });
  facilitator.settle.mockReset().mockResolvedValue({
    success: true,
    transaction: TX,
    network: 'eip155:31337',
    payer: buyer.address,
  });
  const config = parseConfig(
    {
      version: 1,
      merchant: { id: 'quote-test', name: 'Quote test', publicBaseUrl: 'http://localhost:8080' },
      server: { port: 0, host: '127.0.0.1' },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: {
        http: { enabled: true },
        mcp: { enabled: true, mountPath: '/mcp' },
        a2a: { enabled: true, mountPath: '/a2a' },
      },
      resources: {
        [RESOURCE_ID]: {
          name: 'Quoted report',
          input: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
            required: ['symbol'],
            additionalProperties: false,
          },
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/report' },
          pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
          expose: ['http', 'mcp', 'a2a'],
          payments: ['x402'],
        },
      },
      payments: {
        x402: {
          enabled: true,
          network: 'eip155:31337',
          // No RPC service is started; settlement uses the mocked facilitator
          rpcUrl: 'http://127.0.0.1:19321',
          asset: ASSET,
          assetName: 'USDC',
          assetVersion: '2',
          assetDecimals: 6,
          payTo: PAY_TO,
          maxTimeoutSeconds: 120,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'none' },
          },
          quote: { enabled: true, signerPrivateKey: QUOTE_KEY },
        },
      },
    },
    {},
  );
  gateway = await createGateway({
    config,
    store: createFakeStore(),
    paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [createMcpAdapter(), createA2aAdapter()],
    backend: {
      async call() {
        return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
      },
    },
  });
  ({ url } = await gateway.listen());
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await gateway.close().catch(() => {});
});

function invokeHttp(headers: Record<string, string> = {}) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(INPUT),
  });
}

async function callMcp(): Promise<CallToolResult> {
  const client = new Client({ name: 'quote-test-buyer', version: '0.0.0-test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)) as Transport);
  clients.push(client);
  return (await client.callTool({ name: RESOURCE_ID, arguments: INPUT })) as CallToolResult;
}

async function sendA2a(extension: boolean): Promise<A2aTask> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      ...(extension ? { 'a2a-extensions': A2A_X402_EXTENSION_URI } : {}),
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: {
        message: {
          role: 'ROLE_USER',
          messageId: 'msg-buy',
          parts: [{ data: { resource: RESOURCE_ID, input: INPUT }, mediaType: 'application/json' }],
        },
      },
    }),
  });
  return (res.json() as { result: { task: A2aTask } }).result.task;
}

function decodeHeader(value: unknown): PaymentRequired {
  return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8')) as PaymentRequired;
}

function quotesOf(required: { extensions?: Record<string, unknown> } | undefined): SignedQuote[] {
  const extension = required?.extensions?.['erc-8409'] as
    | { info: { quotes: SignedQuote[] } }
    | undefined;
  if (extension === undefined) throw new Error('the challenge carries no erc-8409 extension');
  return extension.info.quotes;
}

// Compute the buyer's agent-commerce/request/v1 hash with the reference
// RFC 8785 implementation, independently of the gateway's hash function
const REQUEST_HASH = keccak256(
  stringToBytes(canonicalize({ input: INPUT, resource: RESOURCE_ID }) as string),
);

describe('ERC-8409 quotes over the gateway', () => {
  it('carries the same signed quotes on HTTP, MCP and both A2A carriers for the same input', async () => {
    const http = await invokeHttp();
    expect(http.statusCode).toBe(402);
    const header = quotesOf(decodeHeader(http.headers[PAYMENT_REQUIRED_HEADER]));
    const body = quotesOf(http.json().payment.envelope);

    const mcp = await callMcp();
    expect(mcp.isError).toBe(true);
    const mcpStructured = quotesOf(mcp.structuredContent as PaymentRequired);
    const mcpMeta = quotesOf(mcp._meta?.['x402/error'] as PaymentRequired);

    const a2aPlain = await sendA2a(false);
    // Without the A2A x402 extension, the gateway envelope is in the task's data part
    const a2aData = a2aPlain.artifacts?.[0]?.parts[0]?.data as {
      payment: { envelope: PaymentRequired };
    };
    const a2aBase = quotesOf(a2aData.payment.envelope);
    const a2aExtension = await sendA2a(true);
    const a2aMetadata = quotesOf(
      a2aExtension.status.message?.metadata?.['x402.payment.required'] as PaymentRequired,
    );

    expect(header).toHaveLength(1);
    expect(header[0]?.quote.requestHash).toBe(REQUEST_HASH);
    // Each transport returns the cached quote within its reuse window
    for (const carried of [body, mcpStructured, mcpMeta, a2aBase, a2aMetadata]) {
      expect(carried).toEqual(header);
    }
  });

  it("signs quotes that recover to the well-known issuer and match the offer's terms", async () => {
    const wellKnown = (
      await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-commerce' })
    ).json();
    expect(wellKnown.payments.x402.quote).toEqual({
      issuer: privateKeyToAccount(QUOTE_KEY as Hex).address,
      requestScheme: 'agent-commerce/request/v1',
      extension: 'erc-8409',
      status: 'experimental',
    });

    const required = decodeHeader((await invokeHttp()).headers[PAYMENT_REQUIRED_HEADER]);
    const [signed] = quotesOf(required);
    const [offer] = required.accepts;
    if (signed === undefined || offer === undefined) throw new Error('no quote or offer');

    // Recover the signer using an independently declared ERC-8409 domain and type
    const { quote } = signed;
    const signer = await recoverTypedDataAddress({
      domain: { name: 'Signed Service Payment Quotes', version: '1', chainId: 31337 },
      types: {
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
      },
      primaryType: 'ServicePaymentQuote',
      message: {
        ...quote,
        amount: BigInt(quote.amount),
        validAfter: BigInt(quote.validAfter),
        validUntil: BigInt(quote.validUntil),
      },
      signature: signed.signature,
    });
    expect(signer).toBe(wellKnown.payments.x402.quote.issuer);
    expect(quote.issuer).toBe(signer);
    expect({
      chainId: signed.chainId,
      recipient: quote.recipient.toLowerCase(),
      asset: quote.asset.toLowerCase(),
      amount: quote.amount,
    }).toEqual({
      chainId: '31337',
      recipient: offer.payTo.toLowerCase(),
      asset: offer.asset.toLowerCase(),
      amount: offer.amount,
    });
    expect(offer.amount).toBe('10000');
  });

  it('settles an SDK payment that echoes the extension, and keeps it from the facilitator', async () => {
    const challenged = await invokeHttp();
    const payments = new x402Client();
    registerExactEvmScheme(payments, { signer: buyer, networks: ['eip155:31337'] });
    // The test token is not in the SDK's spend-control asset list
    payments.setSpendControls(false);
    const httpClient = new x402HTTPClient(payments);
    const required = httpClient.getPaymentRequiredResponse(
      (name) => challenged.headers[name.toLowerCase()] as string | undefined,
    );
    const payload = await httpClient.createPaymentPayload(required);
    expect(quotesOf(payload)).toEqual(quotesOf(required));

    const paid = await invokeHttp(httpClient.encodePaymentSignatureHeader(payload));

    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ report: 'ok' });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    for (const mock of [facilitator.verify, facilitator.settle]) {
      const sent = mock.mock.calls[0]?.[0] as PaymentPayload;
      expect(sent.payload).toEqual(payload.payload);
      expect(sent).not.toHaveProperty('extensions');
    }
  });
});
