/**
 * Exercises an MPP-only config through the same provider builder used by
 * `main.ts`, from parsing to a running gateway
 */
import { Challenge } from 'mppx';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/schema.js';
import type { BackendExecutor } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers.js';
import { validRawConfig } from '../unit/config/fixtures.js';
import { NOOP_TEST_LOGGER } from '../unit/core/execution/helpers.js';
import { createFakeStore } from '../unit/gateway/helpers.js';

process.env['NODE_ENV'] = 'test';

const SECRET = 'mpp-challenge-secret-'.padEnd(32, 'x');
const RPC_KEY = 'RPC-KEY-IN-PATH';
const FACILITATOR_TENANT = 'tenant-in-path';

const MPP = {
  enabled: true,
  rpcUrl: `https://sepolia.example/v2/${RPC_KEY}`,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  assetName: 'USDC',
  assetVersion: '2',
  recipient: '0x1111111111111111111111111111111111111111',
  realm: 'api.example.com',
  challengeSecret: SECRET,
  facilitator: { mode: 'remote', url: `https://facilitator.example/${FACILITATOR_TENANT}` },
};

function mppOnlyConfig(withX402 = false) {
  const raw = validRawConfig();
  const x402 = {
    ...((raw['payments'] as Record<string, Record<string, unknown>>)['x402'] ?? {}),
    payTo: '0x2222222222222222222222222222222222222222',
    facilitator: { mode: 'remote', url: 'https://x402-facilitator.example' },
  };
  raw['payments'] = withX402 ? { x402, mpp: MPP } : { mpp: MPP };
  (raw['resources'] as { market_report: { payments: string[] } }).market_report.payments = ['mpp'];
  return parseConfig(raw, {});
}

const backend: BackendExecutor = {
  async call() {
    return { status: 200, body: {}, headers: {}, durationMs: 1 };
  },
};

let gateway: GatewayInstance | undefined;

afterEach(async () => {
  await gateway?.close().catch(() => {});
  gateway = undefined;
});

describe('payments.mpp wiring', () => {
  it('registers MPP alone, without exposing its x402 settlement provider as a rail', () => {
    const names = (config: ReturnType<typeof mppOnlyConfig>) =>
      createConfiguredPaymentProviders(config.payments, NOOP_TEST_LOGGER).map((p) => p.name);
    expect(names(mppOnlyConfig())).toEqual(['mpp']);
    expect(names(mppOnlyConfig(true))).toEqual(['x402', 'mpp']);
  });

  it('challenges with the configured realm and publishes safe fields only', async () => {
    const config = mppOnlyConfig();
    gateway = await createGateway({
      config,
      store: createFakeStore(),
      paymentProviders: createConfiguredPaymentProviders(config.payments, NOOP_TEST_LOGGER),
      protocolAdapters: [],
      backend,
    });

    const challenged = await gateway.server.inject({
      method: 'POST',
      url: '/api/resources/market_report/invoke',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(challenged.statusCode).toBe(402);
    const challenge = Challenge.deserialize(String(challenged.headers['www-authenticate']));
    expect(challenge).toMatchObject({ realm: 'api.example.com', method: 'evm', intent: 'charge' });

    const wellKnown = await gateway.server.inject({
      method: 'GET',
      url: '/.well-known/agent-commerce',
    });
    expect(wellKnown.json().payments.mpp).toEqual({
      enabled: true,
      network: 'eip155:84532',
      asset: MPP.asset,
      assetName: 'USDC',
      assetVersion: '2',
      assetDecimals: 6,
      recipient: MPP.recipient,
      facilitator: { mode: 'remote' },
      mode: 'testnet',
    });
    for (const secret of [SECRET, RPC_KEY, FACILITATOR_TENANT]) {
      expect(wellKnown.body).not.toContain(secret);
    }
  });
});
