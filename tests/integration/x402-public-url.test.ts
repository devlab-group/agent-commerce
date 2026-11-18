/**
 * Exercise `payments.x402.publicResourceUrl` from config normalization to SDK
 * buyer clients, using the gateway, configured providers and MCP adapter.
 * The facilitator HTTP client is mocked.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapMCPClientWithPayment } from '@x402/mcp';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config';
import { NOOP_LOGGER } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createFakeStore } from '../unit/gateway/helpers';

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitator.verify(...args);
    }
    settle(...args: unknown[]) {
      return facilitator.settle(...args);
    }
  },
}));

const BASE = 'https://shop.example';
const NETWORK = 'eip155:84532';
const INVOKE = `${BASE}/api/resources/report/invoke`;
const TX = `0x${'ab'.repeat(32)}`;
const buyer = privateKeyToAccount(generatePrivateKey());

let gateway: GatewayInstance;
let url = '';
let mcp: Client | undefined;

beforeEach(async () => {
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true, payer: buyer.address });
  facilitator.settle.mockReset().mockResolvedValue({
    success: true,
    transaction: TX,
    network: NETWORK,
    payer: buyer.address,
  });
  const config = parseConfig(
    {
      version: 1,
      merchant: { id: 'shop', name: 'Shop', publicBaseUrl: BASE },
      server: { port: 0, host: '127.0.0.1' },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
      resources: {
        report: {
          name: 'Report',
          input: { type: 'object', properties: {}, additionalProperties: false },
          backend: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
          pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
          expose: ['http', 'mcp'],
          payments: ['x402'],
        },
        // A path separator and a space in an id the HTTP route still finds
        'eu/q3 report': {
          name: 'EU Q3 report',
          input: { type: 'object', properties: {}, additionalProperties: false },
          backend: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
          pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
        },
      },
      payments: {
        x402: {
          enabled: true,
          network: NETWORK,
          rpcUrl: 'http://127.0.0.1:19321', // never contacted
          payTo: '0x1111111111111111111111111111111111111111',
          maxTimeoutSeconds: 120,
          facilitator: { mode: 'remote', url: 'https://facilitator.example' },
          publicResourceUrl: true,
        },
      },
    },
    {},
  );
  gateway = await createGateway({
    config,
    store: createFakeStore(),
    paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [createMcpAdapter()],
    logger: NOOP_LOGGER,
    backend: {
      async call() {
        return { status: 200, body: { report: 'paid' }, headers: {}, durationMs: 1 };
      },
    },
  });
  ({ url } = await gateway.listen());
});

afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  await gateway.close().catch(() => {});
});

function payments(): x402Client {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: buyer, networks: [NETWORK] });
  return client;
}

// Send a request with the configured public Host header
function invoke(path: string, proof?: PaymentPayload) {
  return gateway.server.inject({
    method: 'POST',
    url: path,
    headers: {
      host: new URL(BASE).host,
      'content-type': 'application/json',
      ...(proof !== undefined
        ? { 'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64') }
        : {}),
    },
    payload: {},
  });
}

async function httpChallenge(path = '/api/resources/report/invoke'): Promise<PaymentRequired> {
  const res = await invoke(path);
  expect(res.statusCode).toBe(402);
  return JSON.parse(
    Buffer.from(String(res.headers['payment-required']), 'base64').toString('utf8'),
  ) as PaymentRequired;
}

async function connect(): Promise<Client> {
  mcp = new Client({ name: 'public-url-buyer', version: '0.0.0-test' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)) as Transport);
  return mcp;
}

describe('x402 public resource URL through the gateway', () => {
  it('names the HTTP invoke route, and that URL answers 402', async () => {
    const required = await httpChallenge();
    expect(required.resource.url).toBe(INVOKE);

    const again = await invoke(new URL(required.resource.url).pathname);
    expect(again.statusCode).toBe(402);
  });

  it('encodes an id the URL could not carry, and that URL reaches the same resource', async () => {
    const path = '/api/resources/eu%2Fq3%20report/invoke';
    const required = await httpChallenge(path);
    expect(required.resource.url).toBe(`${BASE}${path}`);

    const again = await httpChallenge(new URL(required.resource.url).pathname);
    expect(again.resource.url).toBe(required.resource.url);
  });

  it('delivers to an SDK proof that echoes the HTTP URL, and settles once', async () => {
    const paid = await invoke(
      '/api/resources/report/invoke',
      await payments().createPaymentPayload(await httpChallenge()),
    );
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual({ report: 'paid' });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('names the MCP mount, and an @x402/mcp client pays it', async () => {
    const client = await connect();
    const challenged = (await client.callTool({ name: 'report', arguments: {} })) as CallToolResult;
    expect((challenged.structuredContent as unknown as PaymentRequired).resource.url).toBe(
      `${BASE}/mcp`,
    );

    const result = await wrapMCPClientWithPayment(client, payments(), {
      autoPayment: true,
    }).callTool('report', {});
    expect(result.paymentMade).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('refuses on MCP a proof made for the HTTP challenge, before the facilitator', async () => {
    const proof = await payments().createPaymentPayload(await httpChallenge());
    const refused = (await (
      await connect()
    ).callTool({
      name: 'report',
      arguments: {},
      _meta: { 'x402/payment': proof },
    })) as CallToolResult;

    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      code: 'PAYMENT_INVALID',
      error: 'invalid_payment_requirements',
    });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});
