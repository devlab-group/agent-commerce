/**
 * docker/gateway-entrypoint.sh, run as the gateway container runs it, with a
 * probe in place of the gateway command.
 *
 * The script turns the chain manifest into the environment the gateway config
 * reads, so a mistake here passes image build, unit tests and local-chain E2E
 * and still breaks the Compose demo. The probe prints what it was handed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MANIFEST = {
  asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  assetName: 'MockUSDC',
  assetVersion: '2',
  assetDecimals: 6,
  merchant: { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
  facilitator: {
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  },
};

const EXPORTED = [
  'X402_ASSET',
  'X402_ASSET_NAME',
  'X402_ASSET_VERSION',
  'X402_ASSET_DECIMALS',
  'MERCHANT_WALLET',
  'X402_FACILITATOR_PRIVATE_KEY',
];
const PROBE = `console.log('PROBE ' + JSON.stringify(Object.fromEntries(${JSON.stringify(EXPORTED)}.map((k) => [k, process.env[k]]))))`;

function manifestFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'oac-entrypoint-')), 'local.json');
  writeFileSync(path, content);
  return path;
}

function run(env: Record<string, string>) {
  const result = spawnSync(
    'bash',
    ['docker/gateway-entrypoint.sh', process.execPath, '-e', PROBE],
    {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  const probeLine = result.stdout.split('\n').find((line) => line.startsWith('PROBE '));
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    exported: probeLine === undefined ? undefined : JSON.parse(probeLine.slice(6)),
  };
}

describe.skipIf(process.platform === 'win32')('gateway container entrypoint', () => {
  it('exports every manifest value the gateway config reads, then runs the command', () => {
    const result = run({ LOCAL_CHAIN_MANIFEST: manifestFile(JSON.stringify(MANIFEST)) });

    expect(result.status).toBe(0);
    expect(result.exported).toEqual({
      X402_ASSET: MANIFEST.asset,
      X402_ASSET_NAME: 'MockUSDC',
      X402_ASSET_VERSION: '2',
      X402_ASSET_DECIMALS: '6',
      MERCHANT_WALLET: MANIFEST.merchant.address,
      X402_FACILITATOR_PRIVATE_KEY: MANIFEST.facilitator.privateKey,
    });
  });

  it('keeps an operator-set payTo and facilitator key, and never prints the key', () => {
    const operatorKey = `0x${'4'.repeat(64)}`;
    const result = run({
      LOCAL_CHAIN_MANIFEST: manifestFile(JSON.stringify(MANIFEST)),
      MERCHANT_WALLET: '0x3333333333333333333333333333333333333333',
      X402_FACILITATOR_PRIVATE_KEY: operatorKey,
      // The deployed asset is not overridable: the manifest names the contract
      X402_ASSET: '0x2222222222222222222222222222222222222222',
    });

    expect(result.status).toBe(0);
    expect(result.exported).toMatchObject({
      MERCHANT_WALLET: '0x3333333333333333333333333333333333333333',
      X402_FACILITATOR_PRIVATE_KEY: operatorKey,
      X402_ASSET: MANIFEST.asset,
    });
    // The probe line carries the key on purpose; the script's own lines must not
    const scriptOutput = result.stdout
      .split('\n')
      .filter((line) => !line.startsWith('PROBE '))
      .join('\n');
    expect(scriptOutput).toContain(
      '[gateway] settlement payTo 0x3333333333333333333333333333333333333333',
    );
    expect(scriptOutput + result.stderr).not.toContain(operatorKey.slice(2));
  });

  it.each([
    ['is not JSON', '{"asset": '],
    ['has no facilitator', JSON.stringify({ ...MANIFEST, facilitator: undefined })],
    ['has no merchant', JSON.stringify({ ...MANIFEST, merchant: undefined })],
  ])('stops before the command when the manifest %s', (_label, content) => {
    const result = run({ LOCAL_CHAIN_MANIFEST: manifestFile(content) });

    expect(result.status).not.toBe(0);
    expect(result.exported).toBeUndefined();
  });

  it('stops before the command when the manifest never appears', () => {
    const result = run({
      LOCAL_CHAIN_MANIFEST: join(tmpdir(), 'oac-entrypoint-absent', 'local.json'),
      LOCAL_CHAIN_MANIFEST_WAIT_SECONDS: '0',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('never appeared');
    expect(result.exported).toBeUndefined();
  });
});
