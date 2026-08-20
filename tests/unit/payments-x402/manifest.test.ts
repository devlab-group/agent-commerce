import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_CHAIN_MANIFEST_PATH,
  type LocalChainManifest,
  readLocalChainManifest,
} from '../../../src/payments/x402/local-chain/manifest.js';

const VALID_MANIFEST: LocalChainManifest = {
  chainId: 84532,
  rpcUrl: 'http://127.0.0.1:8545',
  asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
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

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'oac-manifest-test-'));
}

function writeManifest(cwd: string, value: unknown): void {
  const path = join(cwd, LOCAL_CHAIN_MANIFEST_PATH);
  mkdirSync(join(cwd, '.deploy'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

describe('readLocalChainManifest', () => {
  it('reads a valid manifest written at the documented path', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, VALID_MANIFEST);
    const manifest = readLocalChainManifest(cwd);
    expect(manifest).toEqual(VALID_MANIFEST);
  });

  it('throws a clear, actionable error when the manifest is missing', () => {
    const cwd = tmpCwd();
    expect(() => readLocalChainManifest(cwd)).toThrow(/npm run chain:deploy/);
  });

  it('throws when the file is not valid JSON', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, 'not { valid json');
    expect(() => readLocalChainManifest(cwd)).toThrow(/not valid JSON/);
  });

  it('throws when the manifest is not an object', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, '[]');
    expect(() => readLocalChainManifest(cwd)).toThrow(/JSON object/);
  });

  it('throws when chainId is missing or the wrong type', () => {
    const cwd = tmpCwd();
    const { chainId, ...rest } = VALID_MANIFEST;
    writeManifest(cwd, rest);
    expect(() => readLocalChainManifest(cwd)).toThrow(/chainId/);
  });

  it('throws when assetDecimals is the wrong type', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, { ...VALID_MANIFEST, assetDecimals: '6' });
    expect(() => readLocalChainManifest(cwd)).toThrow(/assetDecimals/);
  });

  it('throws when a required string field is missing or empty', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, { ...VALID_MANIFEST, rpcUrl: '' });
    expect(() => readLocalChainManifest(cwd)).toThrow(/rpcUrl/);
  });

  it('throws when merchant is malformed', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, { ...VALID_MANIFEST, merchant: { address: '0xabc' } });
    expect(() => readLocalChainManifest(cwd)).toThrow(/merchant/);
  });

  it('throws when merchant is not an object', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, { ...VALID_MANIFEST, merchant: null });
    expect(() => readLocalChainManifest(cwd)).toThrow(/merchant/);
  });

  it('throws when buyer is malformed', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, { ...VALID_MANIFEST, buyer: { address: '0xabc' } });
    expect(() => readLocalChainManifest(cwd)).toThrow(/buyer/);
  });

  it('throws when facilitator is malformed', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, {
      ...VALID_MANIFEST,
      facilitator: { address: '0xabc', privateKey: '0xdef' },
    });
    expect(() => readLocalChainManifest(cwd)).toThrow(/facilitator/);
  });

  it('reads hostRpcUrl when present, distinct from rpcUrl', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, { ...VALID_MANIFEST, hostRpcUrl: 'http://127.0.0.1:8545' });
    const manifest = readLocalChainManifest(cwd);
    expect(manifest.hostRpcUrl).toBe('http://127.0.0.1:8545');
  });

  it('still reads a manifest written before hostRpcUrl existed (field absent)', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, VALID_MANIFEST); // VALID_MANIFEST has no hostRpcUrl
    const manifest = readLocalChainManifest(cwd);
    expect(manifest.hostRpcUrl).toBeUndefined();
  });

  it('throws when hostRpcUrl is present but the wrong type', () => {
    const cwd = tmpCwd();
    writeManifest(cwd, { ...VALID_MANIFEST, hostRpcUrl: 123 });
    expect(() => readLocalChainManifest(cwd)).toThrow(/hostRpcUrl/);
  });

  it('defaults to process.cwd() when no cwd is given', () => {
    // Just prove it does not throw a TypeError for the missing argument;
    // whether it finds a real manifest depends on the invoking shell's cwd,
    // which we don't control here, so only assert it throws the "missing"
    // error shape (both possible outcomes go through readLocalChainManifest's
    // own error paths, never a raw TypeError).
    expect(() => readLocalChainManifest()).not.toThrow(TypeError);
  });
});
