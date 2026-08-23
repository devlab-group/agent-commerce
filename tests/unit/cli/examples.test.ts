/**
 * `examples/**` are documentation the moment they stop validating — this
 * guards against silent drift (e.g. a config schema change in `core`) the
 * same way `init-config.test.ts` guards the CLI's own generated config.
 * Each example's own README documents the exact commands to run it for
 * real against the local demo stack; this only checks the shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../../src/config/index.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const EXAMPLES_DIR = join(REPO_ROOT, 'examples');

const EXAMPLES = ['simple-paid-api', 'free-and-premium', 'paid-mcp-tool'] as const;

/**
 * The public-network examples need an environment: on a real chain there is no
 * safe default for a merchant wallet — the only one available would be an Anvil
 * development address, which the guardrails refuse outside local mode. That
 * refusal is the feature, so these are validated with a wallet supplied rather
 * than dropped from the sweep.
 */
const PUBLIC_EXAMPLES = ['base-sepolia', 'base-mainnet', 'base-mainnet-payai'] as const;

const PUBLIC_ENV = {
  MERCHANT_WALLET: '0x1111111111111111111111111111111111111111',
  ALLOW_X402_MAINNET: 'true',
  GATEWAY_PUBLIC_BASE_URL: 'https://gateway.example.com',
  GATEWAY_ADMIN_TOKEN: 'admin-token',
  MERCHANT_API_BASE_URL: 'http://localhost:3000',
  X402_FACILITATOR_URL: 'https://facilitator.example.com',
  CDP_API_KEY_ID: 'key-id',
  CDP_API_KEY_SECRET: 'key-secret',
};

describe('examples/**/config.yaml', () => {
  it.each(EXAMPLES)('%s: validates against the real config loader with no environment', (name) => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, name, 'config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.resources.length).toBeGreaterThan(0);
  });

  it.each(PUBLIC_EXAMPLES)('%s: validates with a merchant wallet supplied', (name) => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, name, 'config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), PUBLIC_ENV);
    expect(config.payments.x402?.facilitator.mode).toBe('remote');
  });

  /**
   * The README's own YAML is documentation the moment it stops validating, and
   * a setup snippet that fails on copy-paste is worse than none. It shipped
   * once missing three required fields.
   */
  it("the README's public-network snippet parses as a real config", () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const block = /```yaml\n(payments:\n[\s\S]*?)```/.exec(readme)?.[1];
    expect(block, 'README no longer contains a `payments:` yaml block').toBeDefined();

    const config = parseConfig(
      parseYaml(`version: 1
merchant: { id: readme, name: Readme, publicBaseUrl: 'http://127.0.0.1:8080' }
server: { port: 8080, host: 127.0.0.1, allowedOrigins: [] }
storage: { receipts: { driver: sqlite, path: ':memory:' } }
protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: /mcp } }
resources:
  r:
    name: R
    backend: { type: http, method: GET, url: 'http://merchant.invalid/x' }
    pricing: { type: fixed, amount: '0.01', currency: USD }
    expose: [http]
    payments: [x402]
${block}`),
      PUBLIC_ENV,
    );
    expect(config.payments.x402?.enabled).toBe(true);
    expect(config.payments.x402?.network).toBe('eip155:84532');
  });

  it('simple-paid-api: HTTP only, one paid resource', () => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, 'simple-paid-api/config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.protocols.http.enabled).toBe(true);
    expect(config.protocols.mcp.enabled).toBe(false);
    expect(config.resources.map((r) => r.pricing.type)).toEqual(['fixed']);
  });

  it('free-and-premium: one free resource, one paid resource, both protocols', () => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, 'free-and-premium/config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.resources.map((r) => r.pricing.type).sort()).toEqual(['fixed', 'free']);
    for (const resource of config.resources) {
      expect([...resource.exposedVia].sort()).toEqual(['http', 'mcp']);
    }
  });

  it('paid-mcp-tool: MCP only, no HTTP protocol at all', () => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, 'paid-mcp-tool/config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.protocols.http.enabled).toBe(false);
    expect(config.protocols.mcp.enabled).toBe(true);
    expect(config.resources[0]?.exposedVia).toEqual(['mcp']);
  });
});
