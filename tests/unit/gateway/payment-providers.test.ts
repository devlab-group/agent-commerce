import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../../src/config';
import { NOOP_LOGGER } from '../../../src/core';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { makeGatewayConfig } from './helpers';

type Payments = GatewayConfig['payments'];
type X402 = NonNullable<Payments['x402']>;
type Mpp = NonNullable<Payments['mpp']>;

const REMOTE_NO_AUTH = {
  mode: 'remote',
  url: 'https://facilitator.example',
  auth: { type: 'none' },
} as const;

// Base mainnet over a remote facilitator with no credential: each rail builds
// only with both acknowledgements set
const MAINNET_X402: X402 = {
  enabled: true,
  network: 'eip155:8453',
  rpcUrl: 'https://base-mainnet.example/rpc',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  assetName: 'USD Coin',
  assetVersion: '2',
  assetDecimals: 6,
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 120,
  facilitator: REMOTE_NO_AUTH,
  allowMainnet: true,
  allowUnauthenticatedFacilitator: true,
};

const MAINNET_MPP: Mpp = {
  enabled: true,
  network: 'eip155:8453',
  rpcUrl: 'https://base-mainnet.example/rpc',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  assetName: 'USD Coin',
  assetVersion: '2',
  recipient: '0x1111111111111111111111111111111111111111',
  realm: 'api.example.com',
  challengeSecret: 'mpp-challenge-secret-'.padEnd(32, 'x'),
  facilitator: REMOTE_NO_AUTH,
  allowMainnet: true,
  allowUnauthenticatedFacilitator: true,
};

function names(payments: Payments): string[] {
  return createConfiguredPaymentProviders(payments, NOOP_LOGGER).map((provider) => provider.name);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createConfiguredPaymentProviders', () => {
  it('builds no provider for a rail that is configured but disabled', () => {
    expect(names({ x402: MAINNET_X402, mpp: MAINNET_MPP })).toEqual(['x402', 'mpp']);
    // A disabled rail must not settle anything, whatever its resources list
    expect(
      names({ x402: { ...MAINNET_X402, enabled: false }, mpp: { ...MAINNET_MPP, enabled: false } }),
    ).toEqual([]);
  });

  it('passes the mainnet acknowledgements through to the providers they gate', () => {
    // Config load checks these too; without the pass-through, a config that
    // loads would still fail at provider construction
    const { allowMainnet: _x402Ack, ...x402NoAck } = MAINNET_X402;
    const { allowUnauthenticatedFacilitator: _x402Anon, ...x402NoAnon } = MAINNET_X402;
    const { allowMainnet: _mppAck, ...mppNoAck } = MAINNET_MPP;
    const { allowUnauthenticatedFacilitator: _mppAnon, ...mppNoAnon } = MAINNET_MPP;

    expect(() => names({ x402: x402NoAck })).toThrow(/allowMainnet/);
    expect(() => names({ x402: x402NoAnon })).toThrow(/allowUnauthenticatedFacilitator/);
    expect(() => names({ mpp: mppNoAck })).toThrow(/allowMainnet/);
    expect(() => names({ mpp: mppNoAnon })).toThrow(/allowUnauthenticatedFacilitator/);
  });

  it('applies the configured MPP challenge lifetime instead of the default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const [provider] = createConfiguredPaymentProviders(
      { mpp: { ...MAINNET_MPP, challengeTtlSeconds: 60 } },
      NOOP_LOGGER,
    );
    const resource = makeGatewayConfig().resources.find((r) => r.id === 'market_report');
    if (provider === undefined || resource === undefined) throw new Error('fixture missing');

    const requirement = await provider.createRequirement({
      requestId: 'req-1',
      resource: { ...resource, paymentMethods: ['mpp'] },
      amount: '0.01',
      currency: 'USDC',
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(requirement.expiresAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it.each([
    ['the rail', { paymentFlow: 'upfront' as const }],
    ['the resource', { resourcePaymentFlows: { market_report: 'upfront' as const } }],
  ])('passes an MPP upfront flow set on %s to the provider', async (_label, flow) => {
    const resource = makeGatewayConfig().resources.find((r) => r.id === 'market_report');
    if (resource === undefined) throw new Error('fixture missing');
    const settleAfterBackend = async (mpp: Mpp): Promise<unknown> => {
      const [provider] = createConfiguredPaymentProviders({ mpp }, NOOP_LOGGER);
      if (provider === undefined) throw new Error('no provider');
      const requirement = await provider.createRequirement({
        requestId: 'req-1',
        resource: { ...resource, paymentMethods: ['mpp'] },
        amount: '0.01',
        currency: 'USDC',
        requestedAt: '2026-01-01T00:00:00.000Z',
      });
      return requirement.metadata?.['settleAfterBackend'];
    };

    expect(await settleAfterBackend(MAINNET_MPP)).toBe(true);
    expect(await settleAfterBackend({ ...MAINNET_MPP, ...flow })).toBe(false);
  });
});
