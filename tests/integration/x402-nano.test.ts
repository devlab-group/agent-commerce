/**
 * A Nano offer from config through the gateway: config load, the 402
 * challenge, a paid request and the same block hash presented again. The Nano
 * node is a stubbed `fetch`; nothing leaves the process.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config';
import { isCommerceError } from '../../src/core';
import { createGateway } from '../../src/gateway';
import { nanoAddressFromPublicKey } from '../../src/payments/x402/nano-address';
import { findX402Network } from '../../src/payments/x402/networks';
import { createX402PaymentProvider } from '../../src/payments/x402/provider';
import { createSqliteReceiptStore } from '../../src/storage/receipts';

const RESOURCE_ID = 'paid_report';
const RPC_URL = 'https://nano-node.example';
const PAY_TO = nanoAddressFromPublicKey('11'.repeat(32));
const BUYER = nanoAddressFromPublicKey('22'.repeat(32));
const HASH = 'CD'.repeat(32);
const FACILITATOR = { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } };

function rawConfig(
  storePath: string,
  currency = 'XNO',
  x402: Record<string, unknown> = {},
): Record<string, unknown> {
  const { network, payTo, rpcUrl, ...rest } = {
    network: 'nano:mainnet',
    rpcUrl: RPC_URL,
    payTo: PAY_TO,
    ...x402,
  };
  const option = 'options' in x402 ? {} : { network, payTo, rpcUrl };
  return {
    version: 1,
    merchant: { id: 'nano', name: 'Nano', publicBaseUrl: 'http://127.0.0.1:8080' },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: storePath } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Paid report',
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: '0.001', currency },
        expose: ['http'],
        payments: ['x402'],
      },
    },
    payments: {
      x402: {
        enabled: true,
        facilitator: FACILITATOR,
        allowMainnet: true,
        allowUnauthenticatedFacilitator: true,
        maxTimeoutSeconds: 120,
        ...option,
        ...rest,
      },
    },
  };
}

function refusal(raw: Record<string, unknown>): string {
  try {
    parseConfig(raw, {});
  } catch (error) {
    if (isCommerceError(error) && error.code === 'CONFIG_INVALID') return error.message;
    throw error;
  }
  throw new Error('expected parseConfig to refuse this configuration');
}

describe('nano:mainnet in config', () => {
  it('is a known network', () => {
    expect(findX402Network('nano:mainnet')?.family).toBe('nano');
  });

  it('loads an offer in native XNO at 30 decimals', () => {
    const x402 = parseConfig(rawConfig('/tmp/unused.sqlite'), {}).payments.x402;
    expect(x402?.options?.[0]).toMatchObject({
      network: 'nano:mainnet',
      payTo: PAY_TO,
      asset: 'XNO',
      assetDecimals: 30,
    });
  });

  it('stores a legacy xrb_ payee in its nano_ form', () => {
    const legacy = PAY_TO.replace('nano_', 'xrb_');
    const x402 = parseConfig(rawConfig('/tmp/unused.sqlite', 'XNO', { payTo: legacy }), {}).payments
      .x402;
    expect(x402?.options?.[0]?.payTo).toBe(PAY_TO);
  });

  it.each<[string, string, Record<string, unknown>, string]>([
    ['a USD price, since XNO has no USD rate', 'USD', {}, 'Price it in XNO'],
    ['a payee with a bad checksum', 'XNO', { payTo: `${PAY_TO.slice(0, -1)}1` }, 'nano_ address'],
    ['a token', 'XNO', { asset: 'USDC' }, 'native coin'],
    ['other decimals', 'XNO', { assetDecimals: 6 }, 'decimals'],
    ['the burn address', 'XNO', { payTo: nanoAddressFromPublicKey('00'.repeat(32)) }, 'zero'],
    ['no mainnet opt-in', 'XNO', { allowMainnet: false }, 'allowMainnet'],
  ])('refuses %s', (_label, currency, x402, message) => {
    expect(refusal(rawConfig('/tmp/unused.sqlite', currency, x402))).toContain(message);
  });

  it('offers Nano beside a USDC rail, on a resource of its own', () => {
    const raw = rawConfig('/tmp/unused.sqlite', 'USD', {
      networks: {
        'nano:mainnet': { rpcUrl: RPC_URL },
        'eip155:8453': { rpcUrl: 'https://base.example' },
      },
      options: [{ network: 'eip155:8453', payTo: '0x1111111111111111111111111111111111111111' }],
    });
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    resources['nano_report'] = {
      ...resources[RESOURCE_ID],
      pricing: { type: 'fixed', amount: '0.001', currency: 'XNO' },
      x402: { accepts: [{ network: 'nano:mainnet', payTo: PAY_TO }] },
    };
    const x402 = parseConfig(raw, {}).payments.x402;
    expect(x402?.options?.map((option) => option.network)).toEqual(['eip155:8453']);
    expect(x402?.resourceOptions?.['nano_report']?.[0]).toMatchObject({
      network: 'nano:mainnet',
      asset: 'XNO',
    });
  });

  it('refuses a list that mixes Nano with a USD-priced token', () => {
    const message = refusal(
      rawConfig('/tmp/unused.sqlite', 'XNO', {
        networks: {
          'nano:mainnet': { rpcUrl: RPC_URL },
          'eip155:8453': { rpcUrl: 'https://base.example' },
        },
        options: [
          { network: 'nano:mainnet', payTo: PAY_TO },
          { network: 'eip155:8453', payTo: '0x1111111111111111111111111111111111111111' },
        ],
      }),
    );
    expect(message).toContain('list only Nano offers');
  });
});

describe('a Nano payment through the gateway', () => {
  let dir: string;
  const rpc = vi.fn<(body: Record<string, unknown>) => unknown>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oac-nano-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockReturnValue({
      block_account: BUYER,
      amount: (10n ** 27n).toString(),
      confirmed: 'true',
      subtype: 'send',
      contents: { type: 'state', account: BUYER, link_as_account: PAY_TO },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        if (url !== RPC_URL) throw new Error(`unexpected request to ${url}`);
        return new Response(JSON.stringify(rpc(JSON.parse(init.body))), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers once per send block and refuses the same hash again', async () => {
    const storePath = join(dir, 'gateway.sqlite');
    const config = parseConfig(rawConfig(storePath), {});
    const store = createSqliteReceiptStore({ path: storePath });
    await store.init();
    let backendCalls = 0;
    const gateway = await createGateway({
      config,
      store,
      paymentProviders: [
        createX402PaymentProvider({
          network: 'nano:mainnet',
          rpcUrl: RPC_URL,
          asset: 'XNO',
          assetDecimals: 30,
          payTo: PAY_TO,
          facilitator: FACILITATOR as never,
          allowMainnet: true,
          allowUnauthenticatedFacilitator: true,
        }),
      ],
      protocolAdapters: [],
      backend: {
        call: async () => {
          backendCalls += 1;
          return { status: 200, headers: {}, body: { ok: true }, durationMs: 1 };
        },
      },
    });
    const invoke = (headers: Record<string, string> = {}) =>
      gateway.server.inject({
        method: 'POST',
        url: `/api/resources/${RESOURCE_ID}/invoke`,
        payload: {},
        headers,
      });

    const challenge = await invoke();
    expect(challenge.statusCode).toBe(402);
    const required = JSON.parse(
      Buffer.from(String(challenge.headers['payment-required']), 'base64').toString('utf8'),
    );
    const accepted = required.accepts[0];
    expect(accepted).toMatchObject({ network: 'nano:mainnet', asset: 'XNO', payTo: PAY_TO });
    expect(accepted.amount).toBe((10n ** 27n).toString());

    const proof = Buffer.from(
      JSON.stringify({ x402Version: 2, accepted, payload: { blockHash: HASH } }),
    ).toString('base64');
    const paid = await invoke({ 'payment-signature': proof });
    expect(paid.statusCode).toBe(200);
    expect(backendCalls).toBe(1);

    const replayed = await invoke({ 'payment-signature': proof });
    expect(replayed.statusCode).toBe(402);
    expect(replayed.json().code).toBe('PAYMENT_REPLAYED');
    expect(backendCalls).toBe(1);
    await gateway.close();
  });
});
