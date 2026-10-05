/**
 * Exercises both x402 flows through the gateway with an SDK-built proof.
 * The facilitator HTTP client is mocked, so its calls show settlement order
 * and whether settlement was attempted.
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config';
import { NOOP_LOGGER } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers';
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

const buyer = privateKeyToAccount(generatePrivateKey());
const TX = `0x${'ef'.repeat(32)}`;
const order: string[] = [];
let backendFails = false;
let gateway: GatewayInstance;

function resource(paymentFlow?: 'upfront') {
  return {
    name: 'Report',
    backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/report' },
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    expose: ['http'],
    payments: ['x402'],
    ...(paymentFlow !== undefined ? { paymentFlow } : {}),
  };
}

beforeEach(async () => {
  order.length = 0;
  backendFails = false;
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true, payer: buyer.address });
  facilitator.settle.mockReset().mockImplementation(async () => {
    order.push('settle');
    return { success: true, transaction: TX, network: 'eip155:84532', payer: buyer.address };
  });
  const config = parseConfig(
    {
      version: 1,
      merchant: { id: 'flow-test', name: 'Flow test', publicBaseUrl: 'http://localhost:8080' },
      server: { port: 0, host: '127.0.0.1' },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: { default_flow: resource(), upfront_flow: resource('upfront') },
      payments: {
        x402: {
          enabled: true,
          network: 'eip155:84532',
          rpcUrl: 'http://127.0.0.1:19321',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          assetName: 'USDC',
          assetVersion: '2',
          assetDecimals: 6,
          payTo: '0x1111111111111111111111111111111111111111',
          maxTimeoutSeconds: 120,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'none' },
          },
        },
      },
    },
    {},
  );
  gateway = await createGateway({
    config,
    store: createFakeStore(),
    paymentProviders: createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [],
    backend: {
      async call() {
        order.push('backend');
        if (backendFails) throw new Error('merchant down');
        return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
      },
    },
  });
});

afterEach(async () => {
  await gateway.close().catch(() => {});
});

const http = new x402HTTPClient(new x402Client());

function invoke(resourceId: string, headers: Record<string, string> = {}) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${resourceId}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: '{}',
  });
}

// Pays the resource's challenge with the x402 SDK client
async function paid(resourceId: string) {
  const challenged = await invoke(resourceId);
  const required = http.getPaymentRequiredResponse(
    (name) => challenged.headers[name.toLowerCase()] as string | undefined,
    challenged.json(),
  ) as PaymentRequired;
  const payments = new x402Client();
  registerExactEvmScheme(payments, { signer: buyer, networks: ['eip155:84532'] });
  payments.setSpendControls(false); // the test token is not in the SDK's list
  const payload = await payments.createPaymentPayload(required);
  return {
    required,
    response: await invoke(resourceId, http.encodePaymentSignatureHeader(payload)),
  };
}

describe('x402 payment flows', () => {
  it('declares no paymentFlow for the default authorization flow, and upfront when set', async () => {
    const defaultFlow = await paid('default_flow');
    const upfront = await paid('upfront_flow');

    expect(defaultFlow.required.accepts[0]?.extra).not.toHaveProperty('paymentFlow');
    expect(upfront.required.accepts[0]?.extra).toMatchObject({ paymentFlow: 'upfront' });
  });

  it('settles after the backend by default and returns the settlement', async () => {
    const { response } = await paid('default_flow');

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['backend', 'settle']);
    expect(response.headers['payment-response']).toBeDefined();
  });

  it('charges nothing when the backend fails under the default flow', async () => {
    backendFails = true;

    const { response } = await paid('default_flow');

    expect(response.statusCode).toBe(502);
    expect(order).toEqual(['backend']);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(response.headers['payment-response']).toBeUndefined();
  });

  it('keeps an upfront payment settled after backend failure', async () => {
    backendFails = true;

    const { response } = await paid('upfront_flow');

    expect(order).toEqual(['settle', 'backend']);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ details: { payment: { status: 'settled' } } });
    expect(response.headers['payment-response']).toBeDefined();
  });

  it('withholds the response when settlement is refused after the backend', async () => {
    facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'eip155:84532',
    });

    const { response } = await paid('default_flow');

    expect(order).toEqual(['backend']);
    expect(response.statusCode).toBe(402);
    expect(response.json()).not.toHaveProperty('report');
    const settlement = JSON.parse(
      Buffer.from(String(response.headers['payment-response']), 'base64').toString('utf8'),
    );
    expect(settlement).toMatchObject({ success: false, errorReason: 'insufficient_funds' });
  });
});
