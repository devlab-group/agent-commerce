import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fillEnvFromLocalChainManifest,
  LOCAL_CHAIN_MANIFEST_PATH,
  MANIFEST_FILLABLE_ENV_VAR_NAMES,
} from '../../../src/cli/lib/manifest-env.js';

const MANIFEST = {
  chainId: 84532,
  rpcUrl: 'http://127.0.0.1:8545',
  asset: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  assetName: 'MockUSDC',
  assetVersion: '2',
  assetDecimals: 6,
  merchant: {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    privateKeyLabel: 'LOCAL DEVELOPMENT ONLY - DO NOT FUND',
  },
  buyer: {
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    note: 'LOCAL DEVELOPMENT ONLY - DO NOT FUND',
  },
  facilitator: {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    note: 'LOCAL DEVELOPMENT ONLY - DO NOT FUND',
  },
  buyerInitialBalance: '100.00',
};

describe('fillEnvFromLocalChainManifest', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-commerce-manifest-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Lays the fixture manifest out at the exact relative path readLocalChainManifest expects under `dir`. */
  function writeManifest(): void {
    mkdirSync(join(dir, '.deploy'), { recursive: true });
    writeFileSync(join(dir, LOCAL_CHAIN_MANIFEST_PATH), JSON.stringify(MANIFEST));
  }

  it('fills every currently-unset manifest variable and reports the manifest as found', () => {
    writeManifest();

    const result = fillEnvFromLocalChainManifest({}, dir);
    expect(result.manifestFound).toBe(true);
    expect(new Set(result.filled)).toEqual(MANIFEST_FILLABLE_ENV_VAR_NAMES);
    expect(result.env['X402_ASSET']).toBe(MANIFEST.asset);
    expect(result.env['X402_ASSET_NAME']).toBe(MANIFEST.assetName);
    expect(result.env['X402_ASSET_VERSION']).toBe(MANIFEST.assetVersion);
    expect(result.env['X402_ASSET_DECIMALS']).toBe(String(MANIFEST.assetDecimals));
    expect(result.env['MERCHANT_WALLET']).toBe(MANIFEST.merchant.address);
    expect(result.env['X402_FACILITATOR_PRIVATE_KEY']).toBe(MANIFEST.facilitator.privateKey);
  });

  it('never overrides a variable the real environment already set', () => {
    writeManifest();

    const result = fillEnvFromLocalChainManifest(
      { X402_ASSET: '0xalready-set-by-a-real-deployment' },
      dir,
    );
    expect(result.env['X402_ASSET']).toBe('0xalready-set-by-a-real-deployment');
    expect(result.filled).not.toContain('X402_ASSET');
    // everything else still fills, since only that one var was set
    expect(result.filled).toContain('MERCHANT_WALLET');
  });

  it('does not mutate the base env object passed in', () => {
    writeManifest();

    const base: NodeJS.ProcessEnv = {};
    fillEnvFromLocalChainManifest(base, dir);
    expect(base['X402_ASSET']).toBeUndefined();
  });

  it('fills nothing and reports no manifest when.deploy/local.json is absent', () => {
    const result = fillEnvFromLocalChainManifest({}, dir);
    expect(result.manifestFound).toBe(false);
    expect(result.filled).toEqual([]);
    expect(result.env).toEqual({});
  });
});
