// Which public-network smoke targets run, decided offline before anything is spent
import { generateKeyPairSync } from 'node:crypto';
import { getBase58Decoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { buyerIdentity } from '../../fixtures/x402/smoke/buyers';
import { planSmoke, SMOKE_TARGETS, type SmokeSettings } from '../../fixtures/x402/smoke/targets';

const EVM = {
  X402_TESTNET_BUYER_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
  X402_TESTNET_MERCHANT_ADDRESS: '0x1111111111111111111111111111111111111111',
};
const NEAR = {
  X402_NEAR_TESTNET_BUYER_ACCOUNT: 'buyer.testnet',
  X402_NEAR_TESTNET_BUYER_PRIVATE_KEY: 'ed25519:buyer-key',
  X402_NEAR_TESTNET_MERCHANT_ACCOUNT: 'merchant.testnet',
};
const BASE_MAINNET = {
  ALLOW_X402_MAINNET: 'true',
  X402_MAINNET_BUYER_PRIVATE_KEY: `0x${'cd'.repeat(32)}`,
  X402_MAINNET_MERCHANT_ADDRESS: '0x2222222222222222222222222222222222222222',
  X402_FACILITATOR_URL: 'https://facilitator.example.com',
};

const ids = (plan: ReturnType<typeof planSmoke>) => plan.run.map(({ target }) => target.id);

describe('planSmoke', () => {
  it('runs nothing without settings, and names what each target needs', () => {
    const testnet = planSmoke('testnet', {});
    expect(testnet).toMatchObject({ run: [], errors: [] });
    expect(testnet.skipped.find(({ id }) => id === 'solana-devnet')?.missing).toEqual([
      'X402_SOLANA_DEVNET_BUYER_SECRET_KEY',
      'X402_SOLANA_DEVNET_MERCHANT_ADDRESS',
    ]);
    // Mainnet also needs its targets named
    expect(planSmoke('mainnet', BASE_MAINNET).skipped[0]?.missing).toEqual(['X402_SMOKE_TARGETS']);
  });

  it('runs the testnet targets whose settings are present, leaving the prepared ones to a name', () => {
    const plan = planSmoke('testnet', EVM);
    expect(ids(plan)).toEqual(['base-sepolia']);
    // Permit2 needs an approval and Arbitrum Sepolia its own USDC
    for (const id of ['base-sepolia-permit2', 'arbitrum-sepolia']) {
      expect(plan.skipped.find((skip) => skip.id === id)?.missing).toEqual(['X402_SMOKE_TARGETS']);
    }
    expect(
      ids(
        planSmoke('testnet', {
          ...EVM,
          X402_SMOKE_TARGETS: 'base-sepolia-permit2,arbitrum-sepolia',
        }),
      ),
    ).toEqual(['base-sepolia-permit2', 'arbitrum-sepolia']);
  });

  it('fails a named target that is unknown, of the other kind, or missing a setting', () => {
    const plan = planSmoke('testnet', {
      ...EVM,
      X402_SMOKE_TARGETS: 'base-sepolia, solana-devnet,base',
    });
    expect(ids(plan)).toEqual(['base-sepolia']);
    expect(plan.errors).toEqual([
      'smoke target "solana-devnet" needs X402_SOLANA_DEVNET_BUYER_SECRET_KEY, X402_SOLANA_DEVNET_MERCHANT_ADDRESS',
      expect.stringMatching(/^unknown testnet smoke target "base"/),
    ]);
  });

  it('moves real funds only with ALLOW_X402_MAINNET set to exactly true', () => {
    const named = { ...BASE_MAINNET, X402_SMOKE_TARGETS: 'base' };
    expect(ids(planSmoke('mainnet', named))).toEqual(['base']);
    expect(planSmoke('mainnet', { ...named, ALLOW_X402_MAINNET: 'yes' }).errors).toEqual([
      'smoke target "base" needs ALLOW_X402_MAINNET=true',
    ]);
  });

  it('pays Base mainnet through Permit2 when base-permit2 is named', () => {
    const plan = planSmoke('mainnet', { ...BASE_MAINNET, X402_SMOKE_TARGETS: 'base-permit2' });
    expect(plan.run.map(({ target }) => [target.id, target.assetTransferMethod])).toEqual([
      ['base-permit2', 'permit2'],
    ]);
  });

  it('refuses a payment above its cap, a run above its total, and a malformed amount', () => {
    const named = { ...EVM, X402_SMOKE_TARGETS: 'base-sepolia,arbitrum-sepolia' };
    expect(planSmoke('testnet', { ...named, X402_SMOKE_AMOUNT: '1.01' }).errors).toContainEqual(
      expect.stringMatching(/above the testnet cap of 1\.00/),
    );
    expect(
      planSmoke('testnet', { ...named, X402_SMOKE_AMOUNT: '0.30', X402_SMOKE_MAX_TOTAL: '0.50' })
        .errors,
    ).toEqual([expect.stringMatching(/more than X402_SMOKE_MAX_TOTAL allows \(0\.50 USDC\)/)]);
    expect(planSmoke('testnet', { ...named, X402_SMOKE_AMOUNT: '$1' }).errors).toContainEqual(
      expect.stringMatching(/not a decimal USDC amount/),
    );
    const mainnet = { ...BASE_MAINNET, X402_SMOKE_TARGETS: 'base', X402_SMOKE_AMOUNT: '0.11' };
    expect(planSmoke('mainnet', mainnet).errors).toContainEqual(
      expect.stringMatching(/above the mainnet cap of 0\.10/),
    );
  });

  it('runs its own NEAR facilitator unless one is named, and keeps every key secret', () => {
    const selfHosted = planSmoke('testnet', {
      ...NEAR,
      X402_NEAR_TESTNET_RELAYER_ACCOUNT: 'relayer.testnet',
      X402_NEAR_TESTNET_RELAYER_PRIVATE_KEY: 'ed25519:relayer-key',
      X402_SMOKE_TARGETS: 'near-testnet',
    }).run[0]?.settings;
    expect(selfHosted?.facilitator).toMatchObject({ type: 'self-hosted-near' });
    expect(selfHosted?.secrets).toEqual(['ed25519:buyer-key', 'ed25519:relayer-key']);

    const remote = planSmoke('testnet', {
      ...NEAR,
      X402_NEAR_TESTNET_FACILITATOR_URL: 'https://near-facilitator.example.com',
      X402_SMOKE_TARGETS: 'near-testnet',
    });
    expect(remote.errors).toEqual([]);
    expect(remote.run[0]?.settings.facilitator).toMatchObject({ type: 'remote' });
  });

  it('pays NEAR mainnet only when allowed, through its own relayer or a named facilitator', () => {
    const near = {
      X402_NEAR_MAINNET_BUYER_ACCOUNT: 'b'.repeat(64),
      X402_NEAR_MAINNET_BUYER_PRIVATE_KEY: 'ed25519:buyer-key',
      X402_NEAR_MAINNET_MERCHANT_ACCOUNT: 'merchant.near',
      X402_NEAR_MAINNET_RELAYER_ACCOUNT: 'relayer.near',
      X402_NEAR_MAINNET_RELAYER_PRIVATE_KEY: 'ed25519:relayer-key',
      X402_SMOKE_TARGETS: 'near',
    };
    expect(planSmoke('mainnet', near).errors).toEqual([
      'smoke target "near" needs ALLOW_X402_MAINNET',
    ]);
    const selfHosted = planSmoke('mainnet', { ...near, ALLOW_X402_MAINNET: 'true' }).run[0];
    expect(selfHosted?.target).toMatchObject({ network: 'near:mainnet', kind: 'mainnet' });
    expect(selfHosted?.settings).toMatchObject({
      rpcUrl: 'https://rpc.mainnet.fastnear.com',
      facilitator: { type: 'self-hosted-near', relayerAccount: 'relayer.near' },
      secrets: ['ed25519:buyer-key', 'ed25519:relayer-key'],
    });

    const remote = planSmoke('mainnet', {
      ...near,
      ALLOW_X402_MAINNET: 'true',
      X402_NEAR_MAINNET_FACILITATOR_URL: 'https://near-facilitator.example.com',
      X402_NEAR_MAINNET_FACILITATOR_TOKEN: 'near-token',
    }).run[0]?.settings;
    expect(remote?.facilitator).toEqual({
      type: 'remote',
      url: 'https://near-facilitator.example.com',
      auth: { type: 'bearer', token: 'near-token' },
    });
    expect(remote?.secrets).toEqual(['ed25519:buyer-key', 'near-token']);
  });

  it("sends a mainnet facilitator credential and keeps it out of the logs' haystack", () => {
    const settings = planSmoke('mainnet', {
      ...BASE_MAINNET,
      X402_SMOKE_TARGETS: 'base',
      CDP_API_KEY_ID: 'key-id',
      CDP_API_KEY_SECRET: 'key-secret',
    }).run[0]?.settings;
    expect(settings?.facilitator).toMatchObject({ auth: { type: 'cdp', apiKeyId: 'key-id' } });
    expect(settings?.secrets).toContain('key-secret');
  });
});

describe('buyerIdentity', () => {
  const target = (id: string) => SMOKE_TARGETS.find((candidate) => candidate.id === id) as never;
  const settings = (buyerKey: string, buyerAccount?: string) =>
    ({ buyerKey, ...(buyerAccount ? { buyerAccount } : {}) }) as SmokeSettings;

  it('reads a Solana secret key as solana-keygen writes it or as a wallet exports it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    const secret = new Uint8Array([...seed, ...raw]);
    const address = getBase58Decoder().decode(raw);

    const devnet = target('solana-devnet');
    expect(await buyerIdentity(devnet, settings(JSON.stringify([...secret])))).toBe(address);
    expect(await buyerIdentity(devnet, settings(getBase58Decoder().decode(secret)))).toBe(address);
  });

  it('derives an EVM address from the key and takes a NEAR account as configured', async () => {
    expect(await buyerIdentity(target('base-sepolia'), settings(`0x${'11'.repeat(32)}`))).toBe(
      '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
    );
    expect(
      await buyerIdentity(target('near-testnet'), settings('ed25519:key', 'buyer.testnet')),
    ).toBe('buyer.testnet');
  });
});
