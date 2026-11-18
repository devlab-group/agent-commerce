// `server.json` from config: the pinned schema, where the version comes from, and the registry's URL rules
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../../src/cli/lib/config-client';
import { type ServerJson, serverJson } from '../../../src/cli/lib/mcp-registry';
import { parseConfig } from '../../../src/config/schema';
import { PACKAGE_VERSION } from '../../../src/version';
import { validRawConfig } from '../config/fixtures';
import { makeGatewayConfig } from './fixtures';

const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
// Byte-identical to modelcontextprotocol/static@a9ba437d
const schema = JSON.parse(
  readFileSync(
    new URL('../../fixtures/mcp-registry/2025-12-11/server.schema.json', import.meta.url),
    'utf8',
  ),
) as { $id: string };
// Disable strict mode to allow the upstream schema's `example` keyword
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateServerJson = ajv.compile(schema);

const REGISTRY = {
  name: 'io.github.acme/weather',
  version: '1.0.0',
  description: 'Weather forecasts, paid per call',
};
// One code point, two UTF-16 units
const ASTRAL = '\u{1D538}';

function config(
  options: { publicBaseUrl?: string; mcp?: GatewayConfig['protocols']['mcp'] } = {},
): GatewayConfig {
  const base = makeGatewayConfig();
  return makeGatewayConfig({
    merchant: {
      ...base.merchant,
      publicBaseUrl: options.publicBaseUrl ?? 'https://api.example.com',
    },
    protocols: {
      ...base.protocols,
      mcp: options.mcp ?? { enabled: true, mountPath: '/mcp', registry: REGISTRY },
    },
  });
}

function listed(registry: typeof REGISTRY): ServerJson {
  const result = serverJson(config({ mcp: { enabled: true, mountPath: '/mcp', registry } }));
  expect(result).toHaveProperty('document');
  return (result as { readonly document: ServerJson }).document;
}

describe('serverJson', () => {
  it('lists the MCP mount under merchant.publicBaseUrl with the configured values', () => {
    expect(serverJson(config())).toEqual({
      document: {
        $schema: SCHEMA_URL,
        name: 'io.github.acme/weather',
        description: 'Weather forecasts, paid per call',
        version: '1.0.0',
        remotes: [{ type: 'streamable-http', url: 'https://api.example.com/mcp' }],
      },
    });
  });

  it('names the schema file the tests validate against', () => {
    expect(schema.$id).toBe(SCHEMA_URL);
  });

  it('joins a base path and the mount with one slash, in the URL parser form', () => {
    const result = serverJson(
      config({
        publicBaseUrl: 'https://API.example.com/shop/',
        mcp: { enabled: true, mountPath: '/tools/mcp/', registry: REGISTRY },
      }),
    );
    expect(result).toMatchObject({
      document: { remotes: [{ url: 'https://api.example.com/shop/tools/mcp' }] },
    });
  });

  it('names the endpoint with the same string as the x402 challenge of an MCP resource', () => {
    const raw = validRawConfig();
    (raw['merchant'] as Record<string, unknown>)['publicBaseUrl'] = 'https://Shop.Example:443/gw/';
    (raw['protocols'] as { mcp: Record<string, unknown> }).mcp['registry'] = REGISTRY;
    (raw['payments'] as { x402: Record<string, unknown> }).x402['publicResourceUrl'] = true;
    const parsed = parseConfig(raw, {});

    const result = serverJson(parsed);

    expect(result).toMatchObject({
      document: { remotes: [{ url: 'https://shop.example/gw/mcp' }] },
    });
    expect(parsed.payments.x402?.resourceUrls?.['market_report']?.mcp).toBe(
      'https://shop.example/gw/mcp',
    );
  });

  it('takes the version from config, not from the package', () => {
    expect(PACKAGE_VERSION).not.toBe('0.3.1');
    expect(listed({ ...REGISTRY, version: '0.3.1' })['version']).toBe('0.3.1');
  });

  it.each([
    ['the values above', REGISTRY],
    ['a 200-character name', { ...REGISTRY, name: `ab/${'c'.repeat(197)}` }],
    ['a 255-character version', { ...REGISTRY, version: `1.0.0-${'a'.repeat(249)}` }],
    ['a 100-character description', { ...REGISTRY, description: 'd'.repeat(100) }],
    ['100 code points outside the BMP', { ...REGISTRY, description: ASTRAL.repeat(100) }],
  ])('validates against the pinned schema with %s', (_label, registry) => {
    const document = listed(registry);
    expect(validateServerJson(document), JSON.stringify(validateServerJson.errors)).toBe(true);
  });

  // The schema refuses one past each limit config enforces
  it.each([
    ['name', `ab/${'c'.repeat(198)}`],
    ['version', `1.0.0-${'a'.repeat(250)}`],
    ['description', 'd'.repeat(101)],
    ['description', ASTRAL.repeat(101)],
  ])('the pinned schema refuses %s %#', (field, value) => {
    expect(validateServerJson({ ...listed(REGISTRY), [field]: value })).toBe(false);
  });

  it.each([
    [
      'MCP is disabled',
      config({ mcp: { enabled: false, mountPath: '/mcp', registry: REGISTRY } }),
      ['protocols.mcp.enabled'],
    ],
    [
      'the block is absent',
      config({ mcp: { enabled: true, mountPath: '/mcp' } }),
      ['protocols.mcp.registry'],
    ],
    [
      'an http URL',
      config({ publicBaseUrl: 'http://api.example.com' }),
      ['merchant.publicBaseUrl'],
    ],
    ['localhost', config({ publicBaseUrl: 'https://localhost:8443' }), ['merchant.publicBaseUrl']],
    ['127.0.0.1', config({ publicBaseUrl: 'https://127.0.0.1' }), ['merchant.publicBaseUrl']],
    [
      'a .localhost name',
      config({ publicBaseUrl: 'https://shop.localhost' }),
      ['merchant.publicBaseUrl'],
    ],
    [
      'a value that is not a URL',
      config({ publicBaseUrl: 'api.example.com' }),
      ['merchant.publicBaseUrl'],
    ],
    [
      'every problem at once',
      config({ publicBaseUrl: 'http://localhost', mcp: { enabled: false, mountPath: '/mcp' } }),
      ['protocols.mcp.enabled', 'protocols.mcp.registry', 'merchant.publicBaseUrl'],
    ],
  ])('refuses %s, naming the key', (_label, input, keys) => {
    expect(serverJson(input)).toEqual({
      problems: keys.map((key) => ({ key, message: expect.any(String) })),
    });
  });

  it('accepts a private address, as the registry does', () => {
    expect(serverJson(config({ publicBaseUrl: 'https://10.0.0.5:8443' }))).toMatchObject({
      document: { remotes: [{ url: 'https://10.0.0.5:8443/mcp' }] },
    });
  });
});
