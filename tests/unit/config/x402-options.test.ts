/**
 * Check direct fields and the `options` array, including asset defaults,
 * overrides and configuration refusals before payment.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import { type CommerceError, isCommerceError } from '../../../src/core';
import { validRawConfig } from './fixtures';

const MERCHANT = '0x1111111111111111111111111111111111111111';
const OTHER_TOKEN = '0x2222222222222222222222222222222222222222';
const REMOTE = {
  mode: 'remote',
  url: 'https://facilitator.example.com',
  auth: { type: 'bearer', token: 'secret-token' },
};

// The fixture's x402 block with its option fields taken out
function operational(): Record<string, unknown> {
  const x402 = { ...(validRawConfig()['payments'] as { x402: Record<string, unknown> }).x402 };
  for (const field of ['network', 'payTo', 'asset', 'assetName', 'assetVersion', 'assetDecimals']) {
    delete x402[field];
  }
  return x402;
}

function withX402(x402: Record<string, unknown>, price?: Record<string, unknown>) {
  const raw = validRawConfig();
  (raw['payments'] as Record<string, unknown>)['x402'] = x402;
  if (price) {
    const resources = raw['resources'] as Record<string, { pricing: Record<string, unknown> }>;
    resources['market_report'] = {
      ...(resources['market_report'] as { pricing: Record<string, unknown> }),
      pricing: { type: 'fixed', ...price },
    };
  }
  return raw;
}

function refusal(raw: Record<string, unknown>): CommerceError {
  try {
    parseConfig(raw, {});
  } catch (error) {
    if (isCommerceError(error) && error.code === 'CONFIG_INVALID') return error;
    throw error;
  }
  throw new Error('expected parseConfig to refuse this configuration');
}

const pathOf = (error: CommerceError) => (error.details as { path?: string }).path;

// A remote testnet option on Base Sepolia, with nothing about the asset
const MINIMAL = { network: 'eip155:84532', payTo: MERCHANT };

describe('payments.x402 forms', () => {
  it('reads the direct fields and a one-element options list identically', () => {
    const direct = validRawConfig();
    const x402 = (direct['payments'] as { x402: Record<string, unknown> }).x402;
    const option = Object.fromEntries(
      ['network', 'payTo', 'asset', 'assetName', 'assetVersion', 'assetDecimals'].map((field) => [
        field,
        x402[field],
      ]),
    );
    const listed = withX402({ ...operational(), options: [option] });
    expect(parseConfig(listed, {}).payments.x402).toEqual(parseConfig(direct, {}).payments.x402);
  });

  it('refuses both forms together, an empty list, and an object in place of the list', () => {
    expect(pathOf(refusal(withX402({ ...operational(), ...MINIMAL, options: [MINIMAL] })))).toBe(
      'payments.x402.options',
    );
    expect(refusal(withX402({ ...operational(), options: [] })).message).toContain('is empty');
    // A schema refusal names its path in the message
    expect(refusal(withX402({ ...operational(), options: MINIMAL })).message).toContain(
      '"payments.x402.options": Expected array',
    );
  });

  it('needs network and payTo when there is no options list', () => {
    expect(pathOf(refusal(withX402({ ...operational(), payTo: MERCHANT })))).toBe(
      'payments.x402.network',
    );
  });

  it('refuses a scheme other than exact', () => {
    const error = refusal(
      withX402({ ...operational(), options: [{ ...MINIMAL, scheme: 'upto' }] }),
    );
    expect(pathOf(error)).toBe('payments.x402.options[0].scheme');
  });
});

describe('default assets', () => {
  it('settles a minimal mainnet option in the network USDC, in either form', () => {
    const mainnet = { ...operational(), facilitator: REMOTE, allowMainnet: true };
    for (const raw of [
      withX402({ ...mainnet, network: 'eip155:8453', payTo: MERCHANT }),
      withX402({ ...mainnet, options: [{ network: 'eip155:8453', payTo: MERCHANT }] }),
    ]) {
      expect(parseConfig(raw, {}).payments.x402).toMatchObject({
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        assetName: 'USD Coin',
        assetVersion: '2',
        assetDecimals: 6,
      });
    }
  });

  it('prices a default-asset option in USD or in the default token, nothing else', () => {
    const minimal = { ...operational(), facilitator: REMOTE, ...MINIMAL };
    for (const currency of ['USD', 'USDC']) {
      expect(() => parseConfig(withX402(minimal, { amount: '0.01', currency }), {})).not.toThrow();
    }
    const error = refusal(withX402(minimal, { amount: '0.01', currency: 'EUR' }));
    expect(pathOf(error)).toBe('resources.market_report.pricing.currency');
  });

  it('keeps a configured asset under the currency label it always had', () => {
    // The fixture names MockUSDC explicitly; its label is the merchant's choice
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, { pricing: Record<string, unknown> }>;
    (resources['market_report'] as { pricing: Record<string, unknown> }).pricing['currency'] =
      'POINTS';
    expect(() => parseConfig(raw, {})).not.toThrow();
  });

  it('refuses a price finer than the default asset, before any conversion', () => {
    const error = refusal(
      withX402(
        { ...operational(), facilitator: REMOTE, ...MINIMAL },
        {
          amount: '0.0000001',
          currency: 'USD',
        },
      ),
    );
    expect(error.message).toContain('6 decimals');
  });
});

describe('asset overrides', () => {
  const base = { ...operational(), facilitator: REMOTE };

  it('refuses metadata that contradicts the default asset it would describe', () => {
    expect(pathOf(refusal(withX402({ ...base, ...MINIMAL, assetDecimals: 18 })))).toBe(
      'payments.x402.assetDecimals',
    );
    const named = refusal(
      withX402({
        ...base,
        ...MINIMAL,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        assetName: 'USD Coin',
      }),
    );
    expect(named.message).toContain('EIP-712 domain name "USDC"');
  });

  it('needs every asset field on the local chain, which has no default token', () => {
    const local = { ...operational(), network: 'eip155:31337', payTo: MERCHANT };
    const error = refusal(withX402({ ...local, asset: OTHER_TOKEN, assetDecimals: 6 }));
    expect(error.message).toContain(
      'has no default asset, so the option needs assetName, assetVersion',
    );
    const token = { asset: OTHER_TOKEN, assetName: 'Other', assetVersion: '1', assetDecimals: 18 };
    expect(() => parseConfig(withX402({ ...local, ...token }), {})).not.toThrow();
  });

  it('refuses another token on a public network, testnet or mainnet', () => {
    const token = { asset: OTHER_TOKEN, assetName: 'Other', assetVersion: '1', assetDecimals: 6 };
    expect(refusal(withX402({ ...base, ...MINIMAL, ...token })).message).toContain(
      'is not USDC on Base Sepolia',
    );
    const mainnet = { ...base, allowMainnet: true, network: 'eip155:1', payTo: MERCHANT };
    expect(refusal(withX402({ ...mainnet, ...token })).message).toContain(
      'is not USDC on Ethereum',
    );
  });
});

describe('payments.x402.networks', () => {
  const OP = { 'eip155:10': { kind: 'mainnet', displayName: 'OP Mainnet' } };
  const token = { asset: OTHER_TOKEN, assetName: 'Token', assetVersion: '1', assetDecimals: 6 };

  it('adds an EVM network with its environment, whose mainnet guardrails then apply', () => {
    const raw = withX402({
      ...operational(),
      facilitator: REMOTE,
      networks: OP,
      network: 'eip155:10',
      payTo: MERCHANT,
      ...token,
    });
    expect(refusal(raw).message).toContain('allowMainnet');
    (raw['payments'] as { x402: Record<string, unknown> }).x402['allowMainnet'] = true;
    expect(parseConfig(raw, {}).payments.x402).toMatchObject({
      network: 'eip155:10',
      networks: OP,
    });
  });

  it('needs the asset spelled out, since a declared network has no default', () => {
    const error = refusal(
      withX402({
        ...operational(),
        facilitator: REMOTE,
        allowMainnet: true,
        networks: OP,
        network: 'eip155:10',
        payTo: MERCHANT,
      }),
    );
    expect(error.message).toContain('has no default asset');
  });

  it('refuses to redeclare a built-in network or to declare a non-EVM one', () => {
    const relabeled = refusal(
      withX402({
        ...operational(),
        ...MINIMAL,
        networks: { 'eip155:8453': { kind: 'testnet', displayName: 'Base' } },
      }),
    );
    expect(pathOf(relabeled)).toBe('payments.x402.networks.eip155:8453');
    const foreign = refusal(
      withX402({
        ...operational(),
        ...MINIMAL,
        networks: { 'solana:x': { kind: 'testnet', displayName: 'X' } },
      }),
    );
    expect(foreign.message).toContain('Only EVM networks can be declared');
  });
});

describe('configurations refused before startup', () => {
  it('points a local config still on eip155:84532 at the local chain id', () => {
    const error = refusal(withX402({ ...operational(), network: 'eip155:84532', payTo: MERCHANT }));
    expect(error.message).toContain('the local Anvil chain is eip155:31337');
    expect(pathOf(error)).toBe('payments.x402.facilitator.mode');
  });

  it('keeps the in-process facilitator on the Anvil chain id', () => {
    const error = refusal(
      withX402({ ...operational(), network: 'eip155:421614', payTo: MERCHANT }),
    );
    expect(pathOf(error)).toBe('payments.x402.facilitator.mode');
  });

  it('checks Solana and TON options, then refuses them as not available yet', () => {
    const solana = { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' };
    const badKey = refusal(
      withX402({
        ...operational(),
        facilitator: REMOTE,
        options: [{ ...solana, payTo: MERCHANT }],
      }),
    );
    expect(badKey.message).toContain('not a plausible address');
    const gated = refusal(
      withX402({
        ...operational(),
        facilitator: REMOTE,
        options: [{ ...solana, payTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }],
      }),
    );
    expect(gated.message).toContain('not available yet');
    expect(pathOf(gated)).toBe('payments.x402.options[0].network');
  });
});

describe('several options', () => {
  const ARBITRUM_SEPOLIA = { network: 'eip155:421614', payTo: MERCHANT };
  const RPCS = {
    'eip155:84532': { rpcUrl: 'https://base-sepolia.example' },
    'eip155:421614': { rpcUrl: 'https://arbitrum-sepolia.example' },
  };
  const remote = () => {
    const { rpcUrl: _shared, ...rest } = operational();
    return { ...rest, facilitator: REMOTE };
  };

  it('resolves each option in order, each with its own network RPC', () => {
    const x402 = parseConfig(
      withX402({ ...remote(), networks: RPCS, options: [MINIMAL, ARBITRUM_SEPOLIA] }),
      {},
    ).payments.x402;
    expect(x402?.options?.map((o) => [o.network, o.rpcUrl, o.asset])).toEqual([
      [
        'eip155:84532',
        'https://base-sepolia.example',
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      ],
      [
        'eip155:421614',
        'https://arbitrum-sepolia.example',
        '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      ],
    ]);
    // The single-option fields repeat the first option
    expect(x402).toMatchObject({ network: 'eip155:84532', rpcUrl: 'https://base-sepolia.example' });
  });

  it('refuses two networks on one RPC endpoint, a repeated option and a mix of kinds', () => {
    const shared = { ...remote(), rpcUrl: 'https://rpc.example' };
    expect(
      refusal(withX402({ ...shared, options: [MINIMAL, ARBITRUM_SEPOLIA] })).message,
    ).toContain('would use the same RPC endpoint');
    expect(refusal(withX402({ ...shared, options: [MINIMAL, MINIMAL] })).message).toContain(
      'repeats an earlier option',
    );
    const mixed = refusal(
      withX402({
        ...remote(),
        allowMainnet: true,
        networks: { ...RPCS, 'eip155:8453': { rpcUrl: 'https://base.example' } },
        options: [MINIMAL, { network: 'eip155:8453', payTo: MERCHANT }],
      }),
    );
    expect(pathOf(mixed)).toBe('payments.x402.options[1].network');
  });

  it('prices every default-asset option in their token or USD', () => {
    const config = { ...remote(), networks: RPCS, options: [MINIMAL, ARBITRUM_SEPOLIA] };
    for (const currency of ['USD', 'USDC']) {
      expect(() => parseConfig(withX402(config, { amount: '0.01', currency }), {})).not.toThrow();
    }
    expect(pathOf(refusal(withX402(config, { amount: '0.01', currency: 'EUR' })))).toBe(
      'resources.market_report.pricing.currency',
    );
  });

  it('bounds the price by the option with the fewest decimals', () => {
    const local = operational();
    const coarse = {
      network: 'eip155:31337',
      payTo: MERCHANT,
      asset: OTHER_TOKEN,
      assetName: 'Coarse',
      assetVersion: '1',
      assetDecimals: 2,
    };
    const mock = (validRawConfig()['payments'] as { x402: Record<string, unknown> }).x402;
    const fine = { ...coarse, asset: mock['asset'], assetName: 'MockUSDC', assetDecimals: 6 };
    const error = refusal(
      withX402({ ...local, options: [fine, coarse] }, { amount: '0.001', currency: 'USDC' }),
    );
    expect(error.message).toContain('2 decimals');
  });

  it('takes an RPC alone for a built-in network, and refuses half a declaration', () => {
    expect(() =>
      parseConfig(withX402({ ...remote(), networks: RPCS, ...MINIMAL }), {}),
    ).not.toThrow();
    const unknown = refusal(
      withX402({
        ...remote(),
        ...MINIMAL,
        rpcUrl: 'https://rpc.example',
        networks: { 'eip155:10': { rpcUrl: 'https://op.example' } },
      }),
    );
    expect(unknown.message).toContain('not a known network');
    const half = refusal(
      withX402({
        ...remote(),
        ...MINIMAL,
        rpcUrl: 'https://rpc.example',
        networks: { 'eip155:10': { kind: 'mainnet' } },
      }),
    );
    expect(half.message).toContain('needs both kind and displayName');
  });
});
