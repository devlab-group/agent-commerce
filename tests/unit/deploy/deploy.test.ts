/**
 * Nothing else in the repository loads the files under `deploy/`: they pin the
 * release they ship and are written against the config schema, and both drift
 * silently. This keeps their configs loadable and their pins at the version
 * in package.json, which the release workflow builds the image from.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const DEPLOY = join(REPO_ROOT, 'deploy');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

const WALLET = '0x1111111111111111111111111111111111111111';
const ENV = {
  MERCHANT_WALLET: WALLET,
  MERCHANT_API_URL: 'http://localhost:3000/v1/quote',
  ADMIN_TOKEN: 'admin-token',
  GATEWAY_SHARED_SECRET: 'shared-secret',
};
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const read = (path: string) => readFileSync(join(DEPLOY, path), 'utf8');
const loadDeployConfig = (path: string, env: NodeJS.ProcessEnv) =>
  loadConfig({ path: join(DEPLOY, path), env });

const textFiles = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.(png|svg)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

// Each pattern captures one pinned ACG version; `<version>` placeholders do not match
const PIN_PATTERNS = [
  /ghcr\.io\/devlab-group\/agent-commerce:([0-9][0-9A-Za-z.+-]*)/g,
  /^ARG ACG_VERSION=(\S+)$/gm,
  /id: \$\$cap_acg_version\s+label: [^\n]+\s+defaultValue: '([^']+)'/g,
  /"version":\s*"([^"]+)"/g,
];

describe('deploy/', () => {
  it('image/config.yaml: the starter configuration loads and charges in Base Sepolia USDC', async () => {
    const config = await loadDeployConfig('image/config.yaml', ENV);
    expect(config.resources.map((r) => [r.id, r.handler])).toEqual([
      ['paid_api', expect.objectContaining({ method: 'GET', url: ENV.MERCHANT_API_URL })],
    ]);
    expect(config.payments.x402?.network).toBe('eip155:84532');
    expect(config.payments.x402?.asset).toBe(BASE_SEPOLIA_USDC);
    expect(config.payments.x402?.payTo).toBe(WALLET);
    expect(config.payments.x402?.facilitator).toMatchObject({
      mode: 'remote',
      url: 'https://x402.org/facilitator',
    });
  });

  // deploy/docs/deploy.md promises this: the starter config never sets allowMainnet
  it('image/config.yaml: a mainnet X402_NETWORK is refused for the missing allowMainnet', async () => {
    await expect(
      loadDeployConfig('image/config.yaml', { ...ENV, X402_NETWORK: 'eip155:8453' }),
    ).rejects.toThrow(/allowMainnet: true/);
  });

  // The demo API and n8n run as separate Compose services with their own network namespaces
  it('testnet-demo/config.yaml: the demo merchant calls its backends by Compose service name', async () => {
    const config = await loadDeployConfig('testnet-demo/config.yaml', ENV);
    expect(config.resources.map((r) => [r.id, r.pricing, r.handler.url])).toEqual([
      ['report', expect.objectContaining({ amount: '0.01' }), 'http://api:3001/api/report'],
      [
        'summarize_url',
        expect.objectContaining({ amount: '0.02' }),
        'http://n8n:5678/webhook/summarize-url',
      ],
    ]);
    expect(config.payments.x402?.network).toBe('eip155:84532');
  });

  it('every pinned ACG version equals package.json', () => {
    const pins: Record<string, string[]> = {};
    for (const path of textFiles(DEPLOY)) {
      const text = readFileSync(path, 'utf8');
      const found = PIN_PATTERNS.flatMap((pattern) =>
        [...text.matchAll(pattern)].map((m) => m[1] as string),
      );
      if (found.length > 0) pins[relative(DEPLOY, path)] = found;
    }
    // A file that stops matching its pattern would otherwise pass unchecked
    expect(Object.keys(pins).sort()).toEqual(
      expect.arrayContaining([
        'README.md',
        'docs/deploy.md',
        'image/Dockerfile',
        'templates/caprover/public/v4/apps/agent-commerce.yml',
        'templates/dokploy/blueprints/agent-commerce/docker-compose.yml',
        'templates/dokploy/blueprints/agent-commerce/meta.json',
        'templates/railway/template.md',
        'templates/zeabur/agent-commerce.yaml',
        'testnet-demo/docker-compose.yml',
      ]),
    );
    const stale = Object.entries(pins).flatMap(([path, versions]) =>
      versions.filter((v) => v !== pkg.version).map((v) => `${path}: ${v}`),
    );
    expect(stale, `pins that differ from package.json ${pkg.version}`).toEqual([]);
  });

  it("the image's optional peers equal package.json peerDependencies", () => {
    // Package declarations use one line each; the final package has no trailing backslash
    const peers = [...read('image/Dockerfile').matchAll(/^\s+(@?[\w./-]+)@(\d\S*)( \\)?$/gm)].map(
      (m) => [m[1], m[2]],
    );
    expect(peers.map(([name]) => name)).toEqual([
      '@x402/core',
      '@x402/evm',
      'viem',
      '@modelcontextprotocol/server',
    ]);
    for (const [name, version] of peers) {
      expect(version, name).toBe(pkg.peerDependencies[name as string]);
    }
  });
});
