/**
 * Exercise `payments.x402.bazaar` through config normalization, the gateway,
 * configured providers, MCP, SDK buyer clients and upstream validation.
 * Mock the facilitator HTTP client and inspect its forwarded payloads.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GatewayConfig, parseConfig } from '../../src/config';
import { NOOP_LOGGER } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createFakeStore } from '../unit/gateway/helpers';

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn(), supported: vi.fn() }));
vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitator.verify(...args);
    }
    settle(...args: unknown[]) {
      return facilitator.settle(...args);
    }
    getSupported() {
      return facilitator.supported();
    }
  },
}));

const BASE = 'https://shop.example';
const NETWORK = 'eip155:84532';
const buyer = privateKeyToAccount(generatePrivateKey());
const backendResource = (expose: string[], payments: string[], input: Record<string, unknown>) => ({
  name: 'Forecast',
  description: 'Forecast for a city',
  input,
  backend: { type: 'http', method: 'POST', url: 'http://backend.local/forecast' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
  expose,
  payments,
});
const CITY = {
  type: 'object',
  properties: { city: { type: 'string' }, days: { type: 'integer', default: 3 } },
  required: ['city', 'days'],
  additionalProperties: false,
};

let config: GatewayConfig;
let gateway: GatewayInstance;
let url = '';
let mcp: Client | undefined;
let warn: ReturnType<typeof vi.spyOn>;

const supported = (extensions: string[]) => ({
  kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
  extensions,
  signers: {},
});

beforeEach(async () => {
  facilitator.supported.mockReset().mockResolvedValue(supported(['bazaar']));
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true, payer: buyer.address });
  facilitator.settle.mockReset().mockResolvedValue({
    success: true,
    transaction: `0x${'ab'.repeat(32)}`,
    network: NETWORK,
    payer: buyer.address,
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  config = parseConfig(
    {
      version: 1,
      merchant: { id: 'shop', name: 'Shop', publicBaseUrl: BASE },
      server: { port: 0, host: '127.0.0.1' },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
      resources: {
        forecast: backendResource(['http', 'mcp'], ['x402'], CITY),
        // Omit Bazaar metadata for this resource because `pattern` is not enforced
        strict: backendResource(['http'], ['x402'], {
          type: 'object',
          properties: { city: { type: 'string', pattern: '^[A-Z]' } },
          required: ['city'],
          additionalProperties: false,
        }),
        mpp_first: backendResource(['http'], ['mpp', 'x402'], CITY),
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
          bazaar: { enabled: true },
        },
        mpp: {
          enabled: true,
          rpcUrl: 'http://127.0.0.1:19321',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          assetName: 'USDC',
          assetVersion: '2',
          recipient: '0x1111111111111111111111111111111111111111',
          realm: 'shop.example',
          challengeSecret: 'mpp-challenge-secret-'.padEnd(32, 'x'),
          facilitator: { mode: 'remote', url: 'https://facilitator.example' },
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
        return { status: 200, body: { forecast: 'sun' }, headers: {}, durationMs: 1 };
      },
    },
  });
  ({ url } = await gateway.listen());
});

afterEach(async () => {
  warn.mockRestore();
  await mcp?.close().catch(() => {});
  mcp = undefined;
  await gateway.close().catch(() => {});
});

const issued = (id: string, surface: 'http' | 'mcp') =>
  config.payments.x402?.resourceBazaar?.[id]?.[surface];

function payments(): x402Client {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: buyer, networks: [NETWORK] });
  return client;
}

function invoke(id: string, body: unknown, proof?: PaymentPayload) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${id}/invoke`,
    headers: {
      host: new URL(BASE).host,
      'content-type': 'application/json',
      ...(proof !== undefined
        ? { 'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64') }
        : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

function challengeOf(res: Awaited<ReturnType<typeof invoke>>): PaymentRequired {
  expect(res.statusCode).toBe(402);
  return JSON.parse(
    Buffer.from(String(res.headers['payment-required']), 'base64').toString('utf8'),
  ) as PaymentRequired;
}

describe('x402 Bazaar metadata through the gateway', () => {
  it('answers the HTTP example, posted as a facilitator probes, with 402 and the metadata', async () => {
    const http = issued('forecast', 'http');
    const probe = (http?.info['input'] as { body?: unknown } | undefined)?.body;
    expect(probe).toEqual({ city: '<city>', days: 3 });

    const required = challengeOf(await invoke('forecast', probe));

    expect(required.resource.url).toBe(`${BASE}/api/resources/forecast/invoke`);
    expect(required.extensions).toEqual({ bazaar: http });
    expect(validateDiscoveryExtension(required.extensions?.['bazaar'] as never)).toEqual({
      valid: true,
    });
  });

  it('answers the MCP example, sent as tool arguments, with a payment-required result and the metadata', async () => {
    const tool = issued('forecast', 'mcp')?.info['input'] as {
      toolName: string;
      example: Record<string, unknown>;
    };
    mcp = new Client({ name: 'bazaar-probe', version: '0.0.0-test' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)) as Transport);

    const result = (await mcp.callTool({
      name: tool.toolName,
      arguments: tool.example,
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'PAYMENT_REQUIRED',
      resource: { url: `${BASE}/mcp` },
      extensions: { bazaar: issued('forecast', 'mcp') },
    });
  });

  it('sends the facilitator the issued metadata when the buyer echoes altered metadata', async () => {
    const proof = await payments().createPaymentPayload(
      challengeOf(await invoke('forecast', { city: 'Oslo', days: 1 })),
    );
    const altered = { ...proof, extensions: { bazaar: { info: { input: { type: 'http' } } } } };

    const paid = await invoke('forecast', { city: 'Oslo', days: 1 }, altered);

    expect(paid.statusCode).toBe(200);
    for (const mock of [facilitator.verify, facilitator.settle]) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0]?.[0]).toMatchObject({
        resource: { url: `${BASE}/api/resources/forecast/invoke` },
        extensions: { bazaar: issued('forecast', 'http') },
      });
    }
  });

  it('sells through a facilitator that does not list the extension, sending it no metadata', async () => {
    facilitator.supported.mockResolvedValue(supported([]));
    const required = challengeOf(await invoke('forecast', { city: 'Oslo', days: 1 }));
    expect(required.extensions).toEqual({ bazaar: issued('forecast', 'http') });

    const paid = await invoke(
      'forecast',
      { city: 'Oslo', days: 1 },
      await payments().createPaymentPayload(required),
    );

    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual({ forecast: 'sun' });
    for (const mock of [facilitator.verify, facilitator.settle]) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(Object.keys(mock.mock.calls[0]?.[0] as object)).toEqual([
        'x402Version',
        'accepted',
        'payload',
      ]);
    }
  });

  it('answers a refused proof with a challenge that keeps the metadata and names the reason', async () => {
    facilitator.verify.mockResolvedValue({
      isValid: false,
      invalidReason: 'invalid_exact_evm_signature',
    });
    const required = challengeOf(await invoke('forecast', { city: 'Oslo', days: 1 }));

    const refused = await invoke(
      'forecast',
      { city: 'Oslo', days: 1 },
      await payments().createPaymentPayload(required),
    );

    expect(challengeOf(refused)).toMatchObject({
      error: 'invalid_exact_evm_signature',
      extensions: { bazaar: issued('forecast', 'http') },
    });
    expect(String(refused.headers['payment-required']).length).toBeLessThanOrEqual(8192);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('warns about a resource left out at load, and still sells it', async () => {
    expect(issued('strict', 'http')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[agent-commerce] resource "strict" gets no Bazaar metadata on http: its input schema cannot be published as is: input.properties.city uses "pattern", which the gateway does not enforce. Payment is unaffected.',
    );
    const required = challengeOf(await invoke('strict', { city: 'Oslo' }));
    expect(required).not.toHaveProperty('extensions');

    const paid = await invoke(
      'strict',
      { city: 'Oslo' },
      await payments().createPaymentPayload(required),
    );

    expect(paid.statusCode).toBe(200);
    expect(Object.keys(facilitator.verify.mock.calls[0]?.[0] as object)).toEqual([
      'x402Version',
      'accepted',
      'payload',
    ]);
  });

  it('answers a resource whose first rail is MPP with an MPP challenge and no metadata', async () => {
    expect(config.payments.x402?.resourceUrls).not.toHaveProperty('mpp_first');
    expect(config.payments.x402?.resourceBazaar).not.toHaveProperty('mpp_first');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'resource "mpp_first" gets no Bazaar metadata: the gateway serves it on mpp',
      ),
    );
    const res = await invoke('mpp_first', { city: 'Oslo', days: 1 });

    expect(res.statusCode).toBe(402);
    expect(res.headers['www-authenticate']).toMatch(/^Payment /);
    expect(res.headers['payment-required']).toBeUndefined();
  });
});
