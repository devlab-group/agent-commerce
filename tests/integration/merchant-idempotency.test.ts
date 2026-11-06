/**
 * Check paid backend requests through config parsing, the gateway, SQLite and
 * the HTTP executor. A fake payment provider keeps these tests independent of
 * a chain.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Keep test output quiet and avoid spawning a pino-pretty worker thread
process.env['NODE_ENV'] = 'test';

import { parseConfig } from '../../src/config';
import { PAYMENT_HEADER } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createSqliteReceiptStore } from '../../src/storage/receipts';
import { createFakePaymentProvider } from '../unit/core/execution/helpers';

// sha256sum of ["paid-operation","https://gw.example","report","replay-valid-proof","sha256:<digest of {}>"]
const KEY = '88f4c564adf4855753414603c78d094f2aa220eb58a6af76363cc0669f60be4e';

const PAYMENT_ROUTE = '/api/resources/report/invoke';

interface MerchantRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let merchant: Server;
let merchantUrl: string;
let merchantStatus = 200;
let received: MerchantRequest[] = [];
let gateway: GatewayInstance | undefined;

beforeAll(async () => {
  merchant = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(merchantStatus, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => merchant.listen(0, '127.0.0.1', resolve));
  merchantUrl = `http://127.0.0.1:${(merchant.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => merchant.close(() => resolve()));
});

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  received = [];
  merchantStatus = 200;
});

function rawConfig(idempotency?: unknown): Record<string, unknown> {
  return {
    version: 1,
    merchant: { id: 'shop', name: 'Shop', publicBaseUrl: 'https://gw.example' },
    server: { port: 0, host: '127.0.0.1' },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      report: {
        name: 'Report',
        input: {
          type: 'object',
          properties: { city: { type: 'string' } },
          additionalProperties: false,
        },
        backend: { type: 'http', method: 'POST', url: `${merchantUrl}/api/report` },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        expose: ['http'],
        payments: ['x402'],
        ...(idempotency !== undefined ? { idempotency } : {}),
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: 'eip155:31337',
        rpcUrl: 'http://127.0.0.1:8545',
        asset: '0x1111111111111111111111111111111111111111',
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        maxTimeoutSeconds: 120,
        facilitator: { mode: 'local', signerPrivateKey: '0xTHIS_IS_A_TEST_ONLY_SECRET_KEY' },
      },
    },
  };
}

async function startGateway(idempotency?: unknown): Promise<GatewayInstance> {
  gateway = await createGateway({
    config: parseConfig(rawConfig(idempotency), {}),
    store: createSqliteReceiptStore({ path: ':memory:' }),
    paymentProviders: [
      createFakePaymentProvider({
        // Model x402 authorization flow, which allows reuse of a rejected payment's authorization
        requirementMetadata: { settleAfterBackend: true, reuseRejectedAuthorization: true },
        verify: async (ctx) => ({
          status: 'verified',
          provider: 'x402',
          amount: '0.01',
          currency: 'USDC',
          payer: '0xBUYER',
          replayKey: `replay-${String(ctx.submission.payload)}`,
        }),
      }),
    ],
    protocolAdapters: [],
  });
  return gateway;
}

function buy(instance: GatewayInstance, payload: Record<string, unknown> = {}) {
  return instance.server.inject({
    method: 'POST',
    url: PAYMENT_ROUTE,
    headers: { [PAYMENT_HEADER]: 'valid-proof' },
    payload,
  });
}

describe('merchant idempotency over the gateway', () => {
  it('sends the merchant the derived key, unquoted', async () => {
    const paid = await buy(await startGateway({ merchantKey: true }));

    expect(paid.statusCode).toBe(200);
    expect(received.map((request) => request.headers['idempotency-key'])).toEqual([KEY]);
  });

  it('sends the same key when a proof is retried after a backend failure', async () => {
    const instance = await startGateway({ merchantKey: true });
    merchantStatus = 500;
    const failed = await buy(instance);
    merchantStatus = 200;
    const retried = await buy(instance);

    expect(failed.statusCode).not.toBe(200);
    expect(retried.statusCode).toBe(200);
    expect(received.map((request) => request.headers['idempotency-key'])).toEqual([KEY, KEY]);
  });

  it('sends another key when a proof is retried with another body', async () => {
    const instance = await startGateway({ merchantKey: true });
    merchantStatus = 500;
    await buy(instance, { city: 'Oslo' });
    merchantStatus = 200;
    const retried = await buy(instance, { city: 'Bergen' });

    expect(retried.statusCode).toBe(200);
    const [first, second] = received.map((request) => request.headers['idempotency-key']);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it('sends the merchant no part of the proof', async () => {
    await buy(await startGateway({ merchantKey: true }));

    expect(received).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain('valid-proof');
  });

  it('changes nothing else the merchant receives', async () => {
    await buy(await startGateway({ merchantKey: true }));
    await gateway?.close();
    const [optedIn] = received;
    received = [];

    await buy(await startGateway());
    const [plain] = received;

    expect(plain?.headers).not.toHaveProperty('idempotency-key');
    const { 'idempotency-key': _key, ...others } = optedIn?.headers ?? {};
    expect(plain).toEqual({ ...optedIn, headers: others });
  });
});
