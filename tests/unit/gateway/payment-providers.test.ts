import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../../src/config';
import { NOOP_LOGGER } from '../../../src/core';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import type { X402PaymentProvider } from '../../../src/payments/x402/provider';
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

async function names(payments: Payments): Promise<string[]> {
  return (await createConfiguredPaymentProviders(payments, NOOP_LOGGER)).map(
    (provider) => provider.name,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createConfiguredPaymentProviders', () => {
  it('builds no provider for a rail that is configured but disabled', async () => {
    expect(await names({ x402: MAINNET_X402, mpp: MAINNET_MPP })).toEqual(['x402', 'mpp']);
    // A disabled rail must not settle anything, whatever its resources list
    expect(
      await names({
        x402: { ...MAINNET_X402, enabled: false },
        mpp: { ...MAINNET_MPP, enabled: false },
      }),
    ).toEqual([]);
  });

  it('passes the mainnet acknowledgements through to the providers they gate', async () => {
    // Config load checks these too; without the pass-through, a config that
    // loads would still fail at provider construction
    const { allowMainnet: _x402Ack, ...x402NoAck } = MAINNET_X402;
    const { allowUnauthenticatedFacilitator: _x402Anon, ...x402NoAnon } = MAINNET_X402;
    const { allowMainnet: _mppAck, ...mppNoAck } = MAINNET_MPP;
    const { allowUnauthenticatedFacilitator: _mppAnon, ...mppNoAnon } = MAINNET_MPP;

    await expect(names({ x402: x402NoAck })).rejects.toThrow(/allowMainnet/);
    await expect(names({ x402: x402NoAnon })).rejects.toThrow(/allowUnauthenticatedFacilitator/);
    await expect(names({ mpp: mppNoAck })).rejects.toThrow(/allowMainnet/);
    await expect(names({ mpp: mppNoAnon })).rejects.toThrow(/allowUnauthenticatedFacilitator/);
  });

  it('applies the configured MPP challenge lifetime instead of the default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const [provider] = await createConfiguredPaymentProviders(
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
    ['the rail', { paymentFlow: 'authorization' as const }],
    ['the resource', { resourcePaymentFlows: { market_report: 'authorization' as const } }],
  ])('passes an MPP authorization flow set on %s to the provider', async (_label, flow) => {
    const resource = makeGatewayConfig().resources.find((r) => r.id === 'market_report');
    if (resource === undefined) throw new Error('fixture missing');
    const settleAfterBackend = async (mpp: Mpp): Promise<unknown> => {
      const [provider] = await createConfiguredPaymentProviders({ mpp }, NOOP_LOGGER);
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

    expect(await settleAfterBackend(MAINNET_MPP)).toBe(false);
    expect(await settleAfterBackend({ ...MAINNET_MPP, ...flow })).toBe(true);
  });

  it('gives a resource with its own offers only those offers', async () => {
    const resource = makeGatewayConfig().resources.find((r) => r.id === 'market_report');
    if (resource === undefined) throw new Error('fixture missing');
    const own = { ...MAINNET_X402, payTo: '0x2222222222222222222222222222222222222222' };
    const [provider] = await createConfiguredPaymentProviders(
      { x402: { ...MAINNET_X402, resourceOptions: { market_report: [own] } } },
      NOOP_LOGGER,
    );
    if (provider === undefined) throw new Error('no provider');
    const payees = async (id: string) =>
      (
        await provider.createRequirement({
          requestId: 'req-1',
          resource: { ...resource, id },
          amount: '0.01',
          currency: 'USDC',
          requestedAt: '2026-01-01T00:00:00.000Z',
        })
      ).challenge.accepts.map((offer) => offer['payTo']);

    expect(await payees('market_report')).toEqual([own.payTo]);
    expect(await payees('another_report')).toEqual([MAINNET_X402.payTo]);
  });

  it("passes the resources' media types to the x402 provider", async () => {
    const resource = makeGatewayConfig().resources.find((r) => r.id === 'market_report');
    if (resource === undefined) throw new Error('fixture missing');
    const [provider] = await createConfiguredPaymentProviders(
      { x402: { ...MAINNET_X402, resourceMimeTypes: { market_report: 'text/csv' } } },
      NOOP_LOGGER,
    );
    if (provider === undefined) throw new Error('no provider');
    const requirement = await provider.createRequirement({
      requestId: 'req-1',
      resource,
      amount: '0.01',
      currency: 'USDC',
      requestedAt: '2026-01-01T00:00:00.000Z',
    });

    const envelope = requirement.challenge.envelope as { resource: Record<string, unknown> };
    expect(envelope.resource['mimeType']).toBe('text/csv');
  });

  it('passes quote to the x402 provider, which publishes its issuer and signs challenges with it', async () => {
    const resource = makeGatewayConfig().resources.find((r) => r.id === 'market_report');
    if (resource === undefined) throw new Error('fixture missing');
    // Test-only key, never funded
    const key = `0x${'33'.repeat(32)}` as const;
    const issuer = privateKeyToAccount(key).address;
    const [provider] = await createConfiguredPaymentProviders(
      { x402: { ...MAINNET_X402, quote: { signerPrivateKey: key } } },
      NOOP_LOGGER,
    );
    if (provider === undefined) throw new Error('no provider');
    const requirement = await provider.createRequirement({
      requestId: 'req-1',
      resource,
      amount: '0.01',
      currency: 'USDC',
      requestedAt: '2026-01-01T00:00:00.000Z',
      input: {},
    });

    expect((provider as X402PaymentProvider).quote).toEqual({
      issuer,
      requestScheme: 'agent-commerce/request/v1',
      extension: 'erc-8409',
    });
    const envelope = requirement.challenge.envelope as {
      extensions: Record<string, { info: { quotes: unknown[] } }>;
    };
    expect(envelope.extensions['erc-8409']?.info.quotes).toEqual([
      expect.objectContaining({ quote: expect.objectContaining({ issuer }) }),
    ]);
  });
});
