import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../../src/config/schema';
import {
  type CommerceError,
  isCommerceError,
  PAYMENT_METHOD_NAMES,
  RESERVED_INPUT_FIELDS,
} from '../../../src/core';
import { compileJsonSchema, validateBackendRequestShape } from '../../../src/core/execution';
import { validRawConfig } from './fixtures';

// Asserts CONFIG_INVALID at `path`: `details.path` for a business rule, the
// first issue's path for a shape error. A bare "it threw" also passes when an
// unrelated defect earlier in the fixture fails first.
function expectConfigInvalid(
  fn: () => unknown,
  path: string,
  message?: string | RegExp,
): CommerceError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!isCommerceError(thrown)) {
    return expect.unreachable(`expected CONFIG_INVALID, got ${String(thrown)}`);
  }
  expect(thrown.code).toBe('CONFIG_INVALID');
  const issues = thrown.details?.['issues'];
  const actual = Array.isArray(issues)
    ? (issues[0] as { path?: unknown } | undefined)?.path
    : thrown.details?.['path'];
  expect(actual, thrown.message).toBe(path);
  if (message !== undefined) expect(thrown.message).toMatch(message);
  return thrown;
}

describe('parseConfig', () => {
  it('accepts a valid config and normalizes resources to a canonical array', () => {
    const config = parseConfig(validRawConfig(), {});
    expect(config.version).toBe(1);
    expect(config.merchant.id).toBe('demo-store');
    expect(config.resources).toHaveLength(2);

    const weather = config.resources.find((r) => r.id === 'weather_basic');
    expect(weather).toBeDefined();
    expect(weather?.pricing).toEqual({ type: 'free' });
    expect(weather?.exposedVia).toEqual(['http', 'mcp']);
    expect(weather?.handler.url).toBe('http://localhost:3000/api/weather/{city}');

    const report = config.resources.find((r) => r.id === 'market_report');
    expect(report?.pricing).toEqual({ type: 'fixed', amount: '0.01', currency: 'USDC' });
    expect(report?.paymentMethods).toEqual(['x402']);

    expect(config.payments.x402?.enabled).toBe(true);
    expect(config.payments.x402?.facilitator).toEqual({
      mode: 'local',
      signerPrivateKey: '0xFACILITATOR_KEY',
    });
  });

  it('rejects an unknown top-level key with a clear path', () => {
    const raw = { ...validRawConfig(), unknownTopLevelField: true };
    expectConfigInvalid(() => parseConfig(raw, {}), '$', /unknownTopLevelField/);
  });

  // A misspelled optional key would otherwise load as if absent: `authorisation:`
  // on a resource would drop its mandate requirement without a word
  it.each([
    'merchant',
    'server',
    'storage.receipts',
    'protocols.mcp',
    'resources.market_report',
    'resources.market_report.backend',
    'resources.market_report.pricing',
    'payments',
    'payments.x402',
    'payments.x402.facilitator',
  ])('rejects an unknown key under %s, naming the block', (where) => {
    const raw = validRawConfig();
    let node: unknown = raw;
    for (const key of where.split('.')) node = (node as Record<string, unknown>)[key];
    (node as Record<string, unknown>)['unexpectedKey'] = true;
    expectConfigInvalid(() => parseConfig(raw, {}), where, /unexpectedKey/);
  });

  it('rejects a config missing a required field', () => {
    const raw = validRawConfig();
    delete (raw['merchant'] as Record<string, unknown>)['id'];
    expectConfigInvalid(() => parseConfig(raw, {}), 'merchant.id');
  });

  it('rejects an unsupported config version with a clear message', () => {
    const raw = { ...validRawConfig(), version: 2 };
    expectConfigInvalid(() => parseConfig(raw, {}), 'version', /Unsupported config version "2"/);
  });

  it('rejects a quoted version "1" with the version message, not a generic zod one', () => {
    const raw = { ...validRawConfig(), version: '1' };
    expect(() => parseConfig(raw, {})).toThrowError(
      /Unsupported config version "1".*written as a number without quotes/,
    );
  });

  it('rejects a backend header that fetch would refuse, naming the key but not the value', () => {
    for (const headers of [{ 'x-api-key': 'secret\ntoken' }, { 'bad name': 'x' }]) {
      const raw = validRawConfig();
      const resources = raw['resources'] as Record<string, Record<string, unknown>>;
      const [resource] = Object.values(resources);
      (resource?.['backend'] as Record<string, unknown>)['headers'] = headers;
      const [key] = Object.keys(headers);
      const error = expectConfigInvalid(
        () => parseConfig(raw, {}),
        `resources.weather_basic.backend.headers.${key}`,
        `backend header "${key}"`,
      );
      expect(JSON.stringify(error.toInfo())).not.toContain('secret');
    }
  });

  it('accepts a backend header value with trailing whitespace, which fetch trims', () => {
    const raw = validRawConfig();
    const [resource] = Object.values(raw['resources'] as Record<string, Record<string, unknown>>);
    (resource?.['backend'] as Record<string, unknown>)['headers'] = { 'x-api-key': 'token\n' };
    expect(() => parseConfig(raw, {})).not.toThrow();
  });

  it('rejects a config missing the version field entirely', () => {
    const raw = validRawConfig();
    delete raw['version'];
    expectConfigInvalid(() => parseConfig(raw, {}), 'version', /missing required field "version"/);
  });

  it('rejects pricing.type "dynamic" with an explicit not-supported message', () => {
    const raw = validRawConfig();
    (raw['resources'] as Record<string, unknown>)['dynamic_res'] = {
      name: 'Dynamic',
      backend: { type: 'http', method: 'GET', url: 'http://localhost:3000/x' },
      pricing: { type: 'dynamic', resolver: 'some-resolver' },
      expose: ['http'],
    };
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.dynamic_res.pricing.type',
      'not supported in this release',
    );
  });

  it.each(['0,01', '$0.01', '1e-2', '-1'])(
    'rejects the malformed pricing.amount %s, which a bare string schema passes and every purchase fails',
    (amount) => {
      const raw = validRawConfig();
      (
        raw['resources'] as { market_report: { pricing: Record<string, unknown> } }
      ).market_report.pricing['amount'] = amount;
      expectConfigInvalid(
        () => parseConfig(raw, {}),
        'resources.market_report.pricing.amount',
        'plain positive decimal',
      );
    },
  );

  it('rejects pricing.amount "0" explicitly, pointing at pricing: { type: free }', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { pricing: Record<string, unknown> } }
    ).market_report.pricing['amount'] = '0';
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.market_report.pricing.amount',
      /cannot cost zero.*type: free/,
    );
  });

  it('rejects pricing.amount with more fractional digits than the asset can represent', () => {
    const raw = validRawConfig();
    // assetDecimals in validRawConfig() is 6
    (
      raw['resources'] as { market_report: { pricing: Record<string, unknown> } }
    ).market_report.pricing['amount'] = '0.0000001';
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.market_report.pricing.amount',
      'more precision',
    );
  });

  it("accepts a pricing.amount using exactly the asset's decimal precision (control)", () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { pricing: Record<string, unknown> } }
    ).market_report.pricing['amount'] = '0.000001';
    const config = parseConfig(raw, {});
    expect(config.resources.find((r) => r.id === 'market_report')?.pricing).toEqual({
      type: 'fixed',
      amount: '0.000001',
      currency: 'USDC',
    });
  });

  describe('backend.url templating', () => {
    function withBackendUrl(url: string): Record<string, unknown> {
      const raw = validRawConfig();
      const resources = raw['resources'] as Record<string, Record<string, unknown>>;
      resources['templated'] = {
        name: 'Templated',
        input: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
        backend: { type: 'http', method: 'GET', url },
        pricing: { type: 'free' },
        expose: ['http'],
      };
      return raw;
    }

    // A parameter in the host would let caller input choose which host the
    // gateway calls (see validatePathParametersDeclared). In a host suffix the
    // text before the brace still parses as an origin, so only the check that
    // the prefix ends in `origin/` refuses it.
    it.each([
      ['the whole host', 'http://{host}/api'],
      ['a host prefix', 'http://{tenant}.api.internal/v1'],
      ['host and port', 'http://{host}:8080/api'],
      ['a host suffix', 'http://api{host}.internal/v1'],
    ])('refuses a parameter that spans %s', (_label, url) => {
      expectConfigInvalid(
        () => parseConfig(withBackendUrl(url), {}),
        'resources.templated.backend.url',
        'before the end of the host',
      );
    });

    it('refuses a parameter in the scheme, via the absolute-URL check', () => {
      // Refused before the host check: `{scheme}://...` does not parse as a
      // URL at all. Asserted separately so a change to either check is
      // visible.
      expectConfigInvalid(
        () => parseConfig(withBackendUrl('{scheme}://backend.local/api'), {}),
        'resources.templated.backend.url',
        'must be an absolute http:// or https:// URL',
      );
    });

    it.each([
      ['a path segment', 'http://backend.local/user/{host}'],
      ['a query value', 'http://backend.local/search?q={host}'],
      ['the whole path', 'http://backend.local/{host}'],
    ])('still accepts a parameter in %s', (_label, url) => {
      expect(() => parseConfig(withBackendUrl(url), {})).not.toThrow();
    });

    // A key substituted into the URL must not reach validate, doctor or
    // startup output, so a refused URL is never quoted
    it.each([
      [
        'a parameter in the host',
        'http://{host}.api.internal/v1?key=${BACKEND_KEY}',
        'before the end of the host',
      ],
      ['no scheme', 'backend.internal/v1?key=${BACKEND_KEY}', 'invalid backend.url'],
    ])('never quotes a refused backend.url with %s', (_label, url, message) => {
      const error = expectConfigInvalid(
        () => parseConfig(withBackendUrl(url), { BACKEND_KEY: 'BACKEND-KEY-IN-URL' }),
        'resources.templated.backend.url',
        message,
      );
      expect(JSON.stringify(error.toInfo())).not.toContain('BACKEND-KEY-IN-URL');
    });

    it('control: the key is substituted into a backend.url that loads', () => {
      const config = parseConfig(withBackendUrl('http://backend.local/{host}?key=${BACKEND_KEY}'), {
        BACKEND_KEY: 'BACKEND-KEY-IN-URL',
      });
      expect(config.resources.find((r) => r.id === 'templated')?.handler).toMatchObject({
        url: 'http://backend.local/{host}?key=BACKEND-KEY-IN-URL',
      });
    });
  });

  describe('closed-schema stamping', () => {
    // The validator applies an `additionalProperties` subschema recursively,
    // so config must close the nodes beneath it too
    it('closes objects nested under an additionalProperties subschema', () => {
      const raw = validRawConfig();
      const resources = raw['resources'] as Record<string, Record<string, unknown>>;
      resources['mapped'] = {
        name: 'Mapped',
        input: {
          type: 'object',
          properties: {
            meta: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
        backend: { type: 'http', method: 'GET', url: 'http://localhost:3000/x' },
        pricing: { type: 'free' },
        expose: ['http'],
      };
      const config = parseConfig(raw, {});
      const schema = config.resources.find((r) => r.id === 'mapped')?.inputSchema as Record<
        string,
        unknown
      >;
      const meta = (schema['properties'] as Record<string, Record<string, unknown>>)['meta'];
      const valueSchema = meta?.['additionalProperties'] as Record<string, unknown>;
      expect(valueSchema['additionalProperties']).toBe(false);

      const validate = compileJsonSchema(schema);
      expect(validate({ meta: { any: { name: 'ok', SMUGGLED: 'x' } } }).valid).toBe(false);
      expect(validate({ meta: { any: { name: 'ok' } } }).valid).toBe(true);
    });
  });

  describe('x402 deployment guardrails', () => {
    const MERCHANT = '0x1111111111111111111111111111111111111111';
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    function withX402(overrides: Record<string, unknown>): Record<string, unknown> {
      const raw = validRawConfig();
      const payments = raw['payments'] as { x402: Record<string, unknown> };
      payments.x402 = { ...payments.x402, ...overrides };
      return raw;
    }

    function messageFor(raw: Record<string, unknown>): string {
      try {
        parseConfig(raw, {});
      } catch (error) {
        if (isCommerceError(error) && error.code === 'CONFIG_INVALID') return error.message;
        throw error;
      }
      throw new Error('expected parseConfig to reject this configuration');
    }

    // A mainnet config that loads; tests that spread it change one field
    const MAINNET = {
      network: 'eip155:8453',
      asset: BASE_USDC,
      assetName: 'USD Coin',
      assetVersion: '2',
      payTo: MERCHANT,
      allowMainnet: true,
      facilitator: {
        mode: 'remote',
        url: 'https://facilitator.example.com',
        auth: { type: 'bearer', token: 'secret-token' },
      },
    };

    it('accepts a remote facilitator on a testnet', () => {
      const config = parseConfig(
        withX402({
          payTo: MERCHANT,
          facilitator: { mode: 'remote', url: 'https://facilitator.example.com' },
        }),
        {},
      );
      // Absent auth is normalized to an explicit "no credential", so nothing
      // downstream has to decide what `undefined` meant
      expect(config.payments.x402?.facilitator).toEqual({
        mode: 'remote',
        url: 'https://facilitator.example.com',
        auth: { type: 'none' },
      });
    });

    it('accepts a fully-specified mainnet configuration', () => {
      const config = parseConfig(
        withX402({
          network: 'eip155:8453',
          asset: BASE_USDC,
          assetName: 'USD Coin',
          payTo: MERCHANT,
          allowMainnet: true,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'bearer', token: 'secret-token' },
          },
        }),
        {},
      );
      expect(config.payments.x402?.allowMainnet).toBe(true);
    });

    it('rejects an unknown CAIP-2 network', () => {
      expect(messageFor(withX402({ network: 'eip155:1' }))).toContain('not a supported network');
      expect(messageFor(withX402({ network: 'solana:mainnet' }))).toContain(
        'not a supported network',
      );
    });

    it('rejects a mainnet served by the in-process facilitator', () => {
      // The local facilitator signs with a key this process holds: a hot
      // wallet inside the resource server
      const message = messageFor(
        withX402({ network: 'eip155:8453', asset: BASE_USDC, payTo: MERCHANT, allowMainnet: true }),
      );
      expect(message).toContain('mainnet');
      expect(message).toContain('remote facilitator');
    });

    it('rejects a mainnet without an explicit opt-in', () => {
      const message = messageFor(
        withX402({
          network: 'eip155:8453',
          asset: BASE_USDC,
          assetName: 'USD Coin',
          payTo: MERCHANT,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'bearer', token: 'secret-token' },
          },
        }),
      );
      expect(message).toContain('allowMainnet');
    });

    it('rejects an unauthenticated mainnet facilitator until it is accepted by name', () => {
      const unauthenticated = {
        network: 'eip155:8453',
        asset: BASE_USDC,
        assetName: 'USD Coin',
        payTo: MERCHANT,
        allowMainnet: true,
        facilitator: { mode: 'remote', url: 'https://facilitator.example.com/v2/x402' },
      };
      const message = messageFor(withX402(unauthenticated));
      expect(message).toContain('allowUnauthenticatedFacilitator');
      // The origin names the counterparty; the path is withheld because it can
      // carry a tenant or a key
      expect(message).toContain('https://facilitator.example.com');
      expect(message).not.toContain('/v2/x402');

      // Accepting it explicitly is allowed
      const config = parseConfig(
        withX402({ ...unauthenticated, allowUnauthenticatedFacilitator: true }),
        {},
      );
      expect(config.payments.x402?.allowUnauthenticatedFacilitator).toBe(true);
    });

    it('does not let allowUnauthenticatedFacilitator stand in for allowMainnet', () => {
      // Two separate decisions: "I meant to use real money" and "I accept this
      // counterparty". Neither implies the other.
      const message = messageFor(
        withX402({
          network: 'eip155:8453',
          asset: BASE_USDC,
          assetName: 'USD Coin',
          payTo: MERCHANT,
          allowUnauthenticatedFacilitator: true,
          facilitator: { mode: 'remote', url: 'https://facilitator.example.com' },
        }),
      );
      expect(message).toContain('allowMainnet');
    });

    it('needs no acknowledgment for an unauthenticated facilitator below mainnet', () => {
      // The public testnet facilitator takes no credential
      expect(() =>
        parseConfig(
          withX402({
            payTo: MERCHANT,
            facilitator: { mode: 'remote', url: 'https://x402.org/facilitator' },
          }),
          {},
        ),
      ).not.toThrow();
    });

    it('rejects a plain-HTTP facilitator on a public host', () => {
      const message = messageFor(
        withX402({
          payTo: MERCHANT,
          facilitator: { mode: 'remote', url: 'http://facilitator.example.com' },
        }),
      );
      expect(message).toContain('plain HTTP');
    });

    it('allows a plain-HTTP facilitator on a private host below mainnet', () => {
      // A dot-free host is a compose or k8s service name whose traffic stays
      // inside the deployment, so TLS is not required below mainnet
      expect(() =>
        parseConfig(
          withX402({
            payTo: MERCHANT,
            facilitator: { mode: 'remote', url: 'http://facilitator:4020' },
          }),
          {},
        ),
      ).not.toThrow();
    });

    it('rejects a well-known development payTo on a non-local deployment', () => {
      // The fixture's payTo is Anvil account #1, whose private key is public
      const message = messageFor(
        withX402({ facilitator: { mode: 'remote', url: 'https://facilitator.example.com' } }),
      );
      expect(message).toContain('well-known Anvil development address');
    });

    it('rejects a mainnet assetName that is not the EIP-712 domain the token reports', () => {
      // Base mainnet USDC reports "USD Coin"; Base Sepolia's reports "USDC".
      // The name is part of the signed EIP-712 domain, so a wrong one would get
      // every payment refused after the buyer signed. Refused at load instead.
      const message = messageFor(
        withX402({
          network: 'eip155:8453',
          asset: BASE_USDC,
          assetName: 'USDC',
          payTo: MERCHANT,
          allowMainnet: true,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'bearer', token: 'secret-token' },
          },
        }),
      );
      expect(message).toContain('EIP-712 domain name');
      expect(message).toContain('USD Coin');
    });

    it('accepts the EIP-712 domain the mainnet token actually reports', () => {
      expect(parseConfig(withX402(MAINNET), {}).payments.x402).toMatchObject({
        assetName: 'USD Coin',
        assetVersion: '2',
      });
    });

    it.each([
      [
        'an assetVersion the token does not report',
        { assetVersion: '1' },
        'payments.x402.assetVersion',
      ],
      [
        'a well-known Anvil payTo',
        { payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
        'payments.x402.payTo',
      ],
    ])('rejects a mainnet config with %s', (_label, change, path) => {
      expectConfigInvalid(() => parseConfig(withX402({ ...MAINNET, ...change }), {}), path);
    });

    it('reads a templated allowMainnet as a boolean, so "false" is no opt-in', () => {
      const raw = withX402({ ...MAINNET, allowMainnet: '${ALLOW_X402_MAINNET}' });
      expectConfigInvalid(
        () => parseConfig(raw, { ALLOW_X402_MAINNET: 'false' }),
        'payments.x402.allowMainnet',
      );
      expect(parseConfig(raw, { ALLOW_X402_MAINNET: 'true' }).payments.x402?.allowMainnet).toBe(
        true,
      );
    });

    it('rejects a mainnet asset that is not the canonical USDC', () => {
      const message = messageFor(
        withX402({
          network: 'eip155:8453',
          payTo: MERCHANT,
          allowMainnet: true,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'bearer', token: 'secret-token' },
          },
        }),
      );
      expect(message).toContain('is not USDC on Base');
    });

    it('rejects a facilitator URL that is neither http nor https', () => {
      expect(
        messageFor(
          withX402({ payTo: MERCHANT, facilitator: { mode: 'remote', url: 'ftp://x402.invalid' } }),
        ),
      ).toContain('must be reached over https');
      expect(
        messageFor(
          withX402({ payTo: MERCHANT, facilitator: { mode: 'remote', url: 'not a url' } }),
        ),
      ).toContain('not a valid URL');
    });

    it('rejects plain HTTP on a mainnet even to a private host', () => {
      // The private-host exception applies below mainnet only
      const message = messageFor(
        withX402({
          network: 'eip155:8453',
          asset: BASE_USDC,
          assetName: 'USD Coin',
          payTo: MERCHANT,
          allowMainnet: true,
          facilitator: {
            mode: 'remote',
            url: 'http://facilitator:4020',
            auth: { type: 'bearer', token: 'secret-token' },
          },
        }),
      );
      expect(message).toContain('plain HTTP');
    });

    it('accepts a mainnet facilitator authenticated with CDP credentials', () => {
      const config = parseConfig(
        withX402({
          network: 'eip155:8453',
          asset: BASE_USDC,
          assetName: 'USD Coin',
          payTo: MERCHANT,
          allowMainnet: true,
          facilitator: {
            mode: 'remote',
            url: 'https://api.cdp.coinbase.com/platform/v2/x402',
            auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: 'key-secret' },
          },
        }),
        {},
      );
      expect(config.payments.x402?.facilitator).toMatchObject({
        mode: 'remote',
        auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: 'key-secret' },
      });
    });

    it('rejects an empty CDP credential rather than sending it', () => {
      const message = messageFor(
        withX402({
          payTo: MERCHANT,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: '${CDP_SECRET:- }' },
          },
        }),
      );
      expect(message).toContain('apiKeySecret is empty');
    });

    it('rejects an auth type nobody implements, rather than sending nothing', () => {
      const raw = withX402({
        payTo: MERCHANT,
        facilitator: {
          mode: 'remote',
          url: 'https://facilitator.example.com',
          auth: { type: 'hmac', secret: 's' },
        },
      });
      expectConfigInvalid(
        () => parseConfig(raw, {}),
        'payments.x402.facilitator.auth.type',
        /'none' \| 'bearer' \| 'cdp'/,
      );
    });

    it('rejects an empty bearer token rather than sending it', () => {
      const raw = withX402({
        payTo: MERCHANT,
        facilitator: {
          mode: 'remote',
          url: 'https://facilitator.example.com',
          auth: { type: 'bearer', token: '${FACILITATOR_TOKEN:- }' },
        },
      });
      expect(messageFor(raw)).toContain('token is empty');
    });
  });

  it.each(RESERVED_INPUT_FIELDS)(
    'rejects a resource whose input.properties declares the reserved "%s" field',
    (reserved) => {
      const raw = validRawConfig();
      (
        raw['resources'] as { weather_basic: { input: { properties: Record<string, unknown> } } }
      ).weather_basic.input.properties[reserved] = { type: 'string' };
      expectConfigInvalid(
        () => parseConfig(raw, {}),
        `resources.weather_basic.input.properties.${reserved}`,
        `input property "${reserved}", which is reserved`,
      );
    },
  );

  it('rejects a paid resource declaring no payment methods', () => {
    const raw = validRawConfig();
    (raw['resources'] as Record<string, unknown>)['broken'] = {
      name: 'Broken',
      backend: { type: 'http', method: 'GET', url: 'http://localhost:3000/x' },
      pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
      expose: ['http'],
    };
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.broken.payments',
      'declares no "payments"',
    );
  });

  it('rejects an mcp-exposed resource whose id is not a legal MCP tool name', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, unknown>;
    resources['weather/basic bad id'] = resources['weather_basic'];
    delete resources['weather_basic'];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather/basic bad id',
      'legal MCP tool name',
    );
  });

  it('accepts an mcp-exposed resource id using only the allowed tool-name characters', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, unknown>;
    resources['weather.basic-v2_1'] = resources['weather_basic'];
    delete resources['weather_basic'];
    const config = parseConfig(raw, {});
    expect(config.resources.some((r) => r.id === 'weather.basic-v2_1')).toBe(true);
  });

  it('rejects a non-http(s) backend.url', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { weather_basic: { backend: Record<string, unknown> } }
    ).weather_basic.backend['url'] = 'ftp://backend.local/x';
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.backend.url',
      'scheme "ftp:"',
    );
  });

  it('rejects a malformed backend.url', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { weather_basic: { backend: Record<string, unknown> } }
    ).weather_basic.backend['url'] = 'not a url at all';
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.backend.url',
      'invalid backend.url',
    );
  });

  it('rejects a paid, {param}-templated resource whose input: is missing entirely - the caller could never supply it, so every call would be refused', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    delete weather['input'];
    weather['pricing'] = { type: 'fixed', amount: '0.01', currency: 'USDC' };
    weather['payments'] = ['x402'];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.backend.url',
      '"{city}" which is not declared',
    );
  });

  it('rejects the same resource when {city} is declared but not required - a call that omits it would be refused', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    weather['input'] = {
      type: 'object',
      properties: { city: { type: 'string' } },
      additionalProperties: false,
      // Declared but not required, so a caller can omit it
    };
    weather['pricing'] = { type: 'fixed', amount: '0.01', currency: 'USDC' };
    weather['payments'] = ['x402'];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.backend.url',
      /"\{city\}" declared .* not listed in its "required"/,
    );
  });

  it.each([
    ['a wildcard', '*', 'wildcard'],
    ['a trailing slash', 'http://localhost:5173/', 'must not end with "/"'],
  ])(
    'rejects an allowedOrigins entry with %s - it is matched literally and would never match',
    (_label, origin, message) => {
      // A silent lockout, which an operator might "fix" by disabling the check
      const raw = validRawConfig();
      (raw['server'] as Record<string, unknown>)['allowedOrigins'] = [origin];
      expectConfigInvalid(() => parseConfig(raw, {}), 'server.allowedOrigins.0', message);
    },
  );

  it('control: a well-formed origin, and an empty list, are accepted', () => {
    for (const origins of [['http://localhost:5173'], []]) {
      const raw = validRawConfig();
      (raw['server'] as Record<string, unknown>)['allowedOrigins'] = origins;
      expect(() => parseConfig(raw, {})).not.toThrow();
    }
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['hex notation', '0x50'],
    ['exponent notation', '1e3'],
  ])('rejects server.port given as %s - Number() would coerce it silently', (_label, port) => {
    // `Number('')` is 0, a valid port ("let the OS pick"), so an empty
    // `${PORT:-}` would bind a random port
    const raw = validRawConfig();
    (raw['server'] as Record<string, unknown>)['port'] = port;
    expectConfigInvalid(() => parseConfig(raw, {}), 'server.port', 'decimal digits');
  });

  it('control: decimal digits, as a string or a number, still work - including 0 meaning "let the OS pick"', () => {
    for (const port of ['8080', 8080, '0', 0]) {
      const raw = validRawConfig();
      (raw['server'] as Record<string, unknown>)['port'] = port;
      expect(parseConfig(raw, {}).server.port).toBe(Number(port));
    }
  });

  it('stamps additionalProperties:false on a node that declares only "required" - core treats it as an object, so config must too', () => {
    // Config and the validator share isObjectSchemaNode, so a `required`-only
    // node is closed rather than forwarding unknown keys to the backend
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    (weather['backend'] as Record<string, unknown>)['url'] = 'http://localhost:3000/api/weather';
    weather['input'] = { properties: { q: { type: 'string' } }, required: ['q'] };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'weather_basic');
    expect(resource).toBeDefined();
    const schema = resource?.inputSchema as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);

    const validate = compileJsonSchema(schema as never);
    expect(validate({ q: 'ok' }).valid).toBe(true);
    expect(validate({ q: 'ok', evil: 'extra-key' }).valid).toBe(false);
  });

  it('rejects a "required" name that "properties" never declares - closing it makes the schema unsatisfiable by any input', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    (weather['backend'] as Record<string, unknown>)['url'] = 'http://localhost:3000/api/weather';
    weather['input'] = { required: ['q'] };
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.input',
      /"q" in "required".*no input can ever satisfy/,
    );
  });

  it('control: a required name may go undeclared when additionalProperties:true leaves it reachable', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    (weather['backend'] as Record<string, unknown>)['url'] = 'http://localhost:3000/api/weather';
    weather['input'] = { required: ['q'], additionalProperties: true };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'weather_basic');
    expect(resource).toBeDefined();
    expect(
      (resource?.inputSchema as Record<string, unknown> | undefined)?.['additionalProperties'],
    ).toBe(true);
  });

  it('rejects a paid resource whose kebab {param} is not declared in its input', () => {
    // `{report-id}` is ordinary REST. If the grammar missed it, the check would
    // see no parameter and the backend would receive `/report/%7Breport-id%7D`
    // after every payment.
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const report = resources['market_report'] as Record<string, unknown>;
    (report['backend'] as Record<string, unknown>)['url'] =
      'http://localhost:3000/api/report/{report-id}';
    delete report['input'];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.market_report.backend.url',
      '"{report-id}" which is not declared',
    );
  });

  it.each([
    ['a space', 'http://localhost:3000/api/report/{report id}'],
    ['a slash', 'http://localhost:3000/api/report/{a/b}'],
    ['nothing at all', 'http://localhost:3000/api/report/{}'],
    ['an unbalanced brace', 'http://localhost:3000/api/report/{oops'],
  ])(
    'rejects a brace token containing %s - widening the grammar cannot cover every spelling, so anything brace-shaped that is not a parameter is refused',
    (_label, url) => {
      const raw = validRawConfig();
      const resources = raw['resources'] as Record<string, Record<string, unknown>>;
      const report = resources['market_report'] as Record<string, unknown>;
      (report['backend'] as Record<string, unknown>)['url'] = url;
      expectConfigInvalid(
        () => parseConfig(raw, {}),
        'resources.market_report.backend.url',
        'not a valid path parameter',
      );
    },
  );

  it('control: a kebab {param} that IS declared and required loads and stays servable - the fix must not reject ordinary REST', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const report = resources['market_report'] as Record<string, unknown>;
    (report['backend'] as Record<string, unknown>)['url'] =
      'http://localhost:3000/api/report/{report-id}';
    report['input'] = {
      type: 'object',
      properties: { 'report-id': { type: 'string' } },
      required: ['report-id'],
    };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    expect(resource?.handler.url).toBe('http://localhost:3000/api/report/{report-id}');
    expect(() =>
      validateBackendRequestShape(
        resource?.handler as never,
        { 'report-id': 'abc' },
        { requestId: 'r', resourceId: 'market_report' },
      ),
    ).not.toThrow();
  });

  it('control: a URL with no braces at all is untouched', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const report = resources['market_report'] as Record<string, unknown>;
    (report['backend'] as Record<string, unknown>)['url'] = 'http://localhost:3000/api/report';
    expect(() => parseConfig(raw, {})).not.toThrow();
  });

  it('control: a paid, {param}-templated resource with city correctly required still loads - do not over-reject', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    // fixtures.ts's weather_basic already declares `required: [city]`; only
    // make it paid
    weather['pricing'] = { type: 'fixed', amount: '0.01', currency: 'USDC' };
    weather['payments'] = ['x402'];
    const config = parseConfig(raw, {});
    expect(config.resources.some((r) => r.id === 'weather_basic')).toBe(true);
  });

  it('accepts a resource declaring both rails, in its own order', () => {
    const raw = validRawConfig();
    (raw['resources'] as { market_report: { payments: string[] } }).market_report.payments = [
      'x402',
      'mpp',
    ];
    const config = parseConfig(raw, {});
    const report = config.resources.find((r) => r.id === 'market_report');
    expect(report?.paymentMethods).toEqual(['x402', 'mpp']);
  });

  it('rejects a paid resource whose only named rail has no provider behind it', () => {
    const raw = validRawConfig();
    (raw['resources'] as { market_report: { payments: string[] } }).market_report.payments = [
      'mpp',
    ];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.market_report.payments',
      'none of which is configured and enabled',
    );
  });

  it('accepts a resource naming a rail with no provider as long as one named rail is enabled', () => {
    const raw = validRawConfig();
    (raw['resources'] as { market_report: { payments: string[] } }).market_report.payments = [
      'mpp',
      'x402',
    ];
    const config = parseConfig(raw, {});
    expect(config.resources.find((r) => r.id === 'market_report')?.paymentMethods).toEqual([
      'mpp',
      'x402',
    ]);
  });

  it('rejects an unsupported payment method, naming it and every supported rail', () => {
    const raw = validRawConfig();
    (raw['resources'] as { market_report: { payments: string[] } }).market_report.payments = [
      'stripe',
    ];
    const error = expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.market_report.payments',
      'unsupported payment method "stripe"',
    );
    for (const name of PAYMENT_METHOD_NAMES) expect(error.message).toContain(name);
  });

  it('rejects a value below the minimum bound (maxTimeoutSeconds)', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['maxTimeoutSeconds'] = 0;
    expectConfigInvalid(() => parseConfig(raw, {}), 'payments.x402.maxTimeoutSeconds', '>= 1');
  });

  it('rejects a value above the maximum bound (assetDecimals)', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['assetDecimals'] = 100;
    expectConfigInvalid(() => parseConfig(raw, {}), 'payments.x402.assetDecimals', '<= 36');
  });

  it('rejects a paid resource when payments.x402.enabled is false', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['enabled'] = false;
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.market_report.payments',
      '"x402", none of which is configured and enabled',
    );
  });

  it('rejects an expose value outside the supported protocols, mentioning UCP is planned', () => {
    const raw = validRawConfig();
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = [
      'http',
      'ucp',
    ];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.expose',
      /unsupported protocol "ucp" \(UCP is planned/,
    );
  });

  it('rejects an unknown expose value that is not ucp too, without the UCP hint', () => {
    const raw = validRawConfig();
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = [
      'http',
      'grpc',
    ];
    const error = expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.expose',
      'unsupported protocol "grpc"',
    );
    expect(error.message).not.toContain('UCP');
  });

  it.each(['mcp', 'http'])(
    'rejects an expose:[%s] resource when that protocol is disabled',
    (protocol) => {
      const raw = validRawConfig();
      ((raw['protocols'] as Record<string, unknown>)[protocol] as Record<string, unknown>)[
        'enabled'
      ] = false;
      expectConfigInvalid(
        () => parseConfig(raw, {}),
        'resources.weather_basic.expose',
        `protocols.${protocol}.enabled is false`,
      );
    },
  );

  it.each([
    ['payTo', 'not-an-address', 'not a plausible address'],
    ['payTo', '0x0000000000000000000000000000000000000000', 'zero address'],
    ['asset', '0xshort', 'not a plausible address'],
    // The guardrails repeat the payTo check but not this one
    ['asset', '0x0000000000000000000000000000000000000000', 'must not be the zero address'],
  ])('rejects payments.x402.%s set to %s', (field, value, message) => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402[field] = value;
    expectConfigInvalid(() => parseConfig(raw, {}), `payments.x402.${field}`, message);
  });

  it('accepts a lowercase or uppercase address (checksum-insensitive)', () => {
    for (const payTo of [`0x${'a'.repeat(40)}`, `0x${'A'.repeat(40)}`]) {
      const raw = validRawConfig();
      (raw['payments'] as { x402: Record<string, unknown> }).x402['payTo'] = payTo;
      expect(parseConfig(raw, {}).payments.x402?.payTo).toBe(payTo);
    }
  });

  describe('unsupported schema keyword warning', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns when a resource schema uses an unsupported keyword like pattern', () => {
      const raw = validRawConfig();
      (
        raw['resources'] as { market_report: { input: Record<string, unknown> } }
      ).market_report.input = {
        type: 'object',
        properties: { city: { type: 'string', pattern: '^[a-z]+$' } },
        additionalProperties: false,
      };
      parseConfig(raw, {});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('pattern');
      expect(warnSpy.mock.calls[0]?.[0]).toContain('market_report');
    });

    it('warns on tuple-form items (an array of schemas), which the validator does not enforce', () => {
      const raw = validRawConfig();
      (
        raw['resources'] as { market_report: { input: Record<string, unknown> } }
      ).market_report.input = {
        type: 'object',
        properties: {
          pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
        },
        additionalProperties: false,
      };
      parseConfig(raw, {});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('tuple');
      expect(warnSpy.mock.calls[0]?.[0]).toContain('market_report');
    });

    it('does not warn for a schema using only the supported subset', () => {
      parseConfig(validRawConfig(), {});
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('rejects a schema declaring properties/required whose type excludes "object" - the validator would never enforce either', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      type: 'string', // copy-paste-stale: properties/required imply object
      properties: { city: { type: 'string' } },
      required: ['city'],
    };
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.market_report.input',
      'does not include "object"',
    );
  });

  it('control: properties/required with NO type at all still loads - the validator treats that as an object schema', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      properties: { note: { type: 'string' } },
    };
    const config = parseConfig(raw, {});
    expect(config.resources.some((r) => r.id === 'market_report')).toBe(true);
  });

  it('defaults a missing additionalProperties to false on an object input schema', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      type: 'object',
      properties: { city: { type: 'string' } },
    };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    expect(resource?.inputSchema?.['additionalProperties']).toBe(false);
  });

  it('respects an explicit additionalProperties: true rather than overriding it', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      type: 'object',
      properties: { city: { type: 'string' } },
      additionalProperties: true,
    };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    expect(resource?.inputSchema?.['additionalProperties']).toBe(true);
  });

  it('closes an object schema declared with a `type` array, e.g. ["object","null"]', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      type: ['object', 'null'],
      properties: { city: { type: 'string' } },
    };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    expect(resource?.inputSchema?.['additionalProperties']).toBe(false);
  });

  it('closes a NESTED object schema too, not just the root', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { anything: { type: 'string' } },
          // No additionalProperties: config must close this level as well as
          // the root
        },
      },
      additionalProperties: false,
    };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    const properties = resource?.inputSchema?.['properties'] as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(properties?.['filter']?.['additionalProperties']).toBe(false);
  });

  it('closes an object schema nested under `items` too', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
      additionalProperties: false,
    };
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    const rows = (
      resource?.inputSchema?.['properties'] as Record<string, Record<string, unknown>>
    )?.['rows'];
    const items = rows?.['items'] as Record<string, unknown> | undefined;
    expect(items?.['additionalProperties']).toBe(false);
  });

  it('a resource that declares no input: at all still gets a closed (empty-object) schema, not an always-valid one', () => {
    const raw = validRawConfig();
    delete (raw['resources'] as { market_report: { input?: unknown } }).market_report.input;
    const config = parseConfig(raw, {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    expect(resource?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('defaults server.allowedOrigins to [] and leaves adminToken unset', () => {
    const config = parseConfig(validRawConfig(), {});
    expect(config.server.allowedOrigins).toEqual([]);
    expect(config.server.adminToken).toBeUndefined();
  });

  it('accepts server.adminToken and server.allowedOrigins', () => {
    const raw = validRawConfig();
    (raw['server'] as Record<string, unknown>)['adminToken'] = 'shh-secret';
    (raw['server'] as Record<string, unknown>)['allowedOrigins'] = ['http://localhost:5173'];
    const config = parseConfig(raw, {});
    expect(config.server.adminToken).toBe('shh-secret');
    expect(config.server.allowedOrigins).toEqual(['http://localhost:5173']);
  });

  it('coerces boolean fields supplied as strings', () => {
    const raw = validRawConfig();
    (raw['protocols'] as { http: Record<string, unknown> }).http['enabled'] = 'true';
    const config = parseConfig(raw, {});
    expect(config.protocols.http.enabled).toBe(true);
  });

  it('rejects a non-integer port', () => {
    const raw = validRawConfig();
    (raw['server'] as Record<string, unknown>)['port'] = 8080.5;
    expectConfigInvalid(() => parseConfig(raw, {}), 'server.port', 'must be an integer');
  });

  it('rejects a port out of range', () => {
    const raw = validRawConfig();
    (raw['server'] as Record<string, unknown>)['port'] = 70000;
    expectConfigInvalid(() => parseConfig(raw, {}), 'server.port', '<= 65535');
  });

  it('rejects a garbage boolean string', () => {
    const raw = validRawConfig();
    (raw['protocols'] as { http: Record<string, unknown> }).http['enabled'] = 'maybe';
    expectConfigInvalid(() => parseConfig(raw, {}), 'protocols.http.enabled', 'must be a boolean');
  });

  it.each([
    ['a string', 'not-an-object'],
    ['null', null],
    ['an array', [1, 2, 3]],
  ])('rejects %s as the config root', (_label, root) => {
    expectConfigInvalid(() => parseConfig(root, {}), '$', 'root must be a mapping');
  });

  it('resolves ${VAR} placeholders from the provided env', () => {
    const raw = validRawConfig();
    (raw['merchant'] as Record<string, unknown>)['publicBaseUrl'] = '${GATEWAY_PUBLIC_BASE_URL}';
    const config = parseConfig(raw, { GATEWAY_PUBLIC_BASE_URL: 'http://example.test' });
    expect(config.merchant.publicBaseUrl).toBe('http://example.test');
  });

  it('throws CONFIG_INVALID naming the variable when ${VAR} is unresolved', () => {
    const raw = validRawConfig();
    (raw['merchant'] as Record<string, unknown>)['publicBaseUrl'] = '${GATEWAY_PUBLIC_BASE_URL}';
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      '$.merchant.publicBaseUrl',
      'Unresolved environment variable "${GATEWAY_PUBLIC_BASE_URL}"',
    );
  });

  it('never prints a resolved secret in the error for an unrelated failure', () => {
    const secret = 'super-secret-facilitator-key-0xDEADBEEF';
    const raw = validRawConfig();
    const x402 = (raw['payments'] as { x402: Record<string, unknown> }).x402;
    x402['facilitator'] = { mode: 'local', signerPrivateKey: '${SIGNER_KEY}' };
    const env = { SIGNER_KEY: secret };
    // Control: the secret resolves into the loaded config
    const facilitator = parseConfig(raw, env).payments.x402?.facilitator;
    expect(facilitator?.mode === 'local' && facilitator.signerPrivateKey).toBe(secret);

    x402['payTo'] = 'not-an-address';
    const error = expectConfigInvalid(() => parseConfig(raw, env), 'payments.x402.payTo');
    expect(JSON.stringify(error.toInfo())).not.toContain(secret);
  });
});

describe('protocols.mcp.mountPath', () => {
  function withMountPath(mountPath: unknown): Record<string, unknown> {
    const raw = validRawConfig();
    (raw['protocols'] as { mcp: Record<string, unknown> }).mcp['mountPath'] = mountPath;
    return raw;
  }

  // Fastify would fail these at server.ready(), taking the whole gateway down
  // with an opaque FST_ERR_*. They must be CONFIG_INVALID at load.
  it.each([
    ['no leading slash', 'mcp', 'must start with "/"'],
    ['a Fastify parameter', '/mcp/:id', 'must not contain'],
    ['a Fastify wildcard', '/mcp/*', 'must not contain'],
    ['a query marker', '/mcp?x=1', 'must not contain'],
    ['whitespace', '/mcp path', 'must not contain'],
    ['a trailing newline', '/mcp\n', 'must not contain'],
    ['a route the gateway serves', '/health', 'must not collide'],
    ['another route the gateway serves', '/api/receipts', 'must not collide'],
    ['a prefix of a gateway route', '/api', 'must not collide'],
    ['the root path, which is a prefix of everything', '/', 'must not collide'],
  ])('rejects %s', (_label, mountPath, message) => {
    expectConfigInvalid(
      () => parseConfig(withMountPath(mountPath), {}),
      'protocols.mcp.mountPath',
      message,
    );
  });

  it('names the offending field in the error message', () => {
    expect(() => parseConfig(withMountPath('/health'), {})).toThrowError(
      'Configuration invalid at "protocols.mcp.mountPath"',
    );
  });

  it('control: an ordinary mount path still validates', () => {
    const config = parseConfig(withMountPath('/mcp'), {});
    expect(config.protocols.mcp.mountPath).toBe('/mcp');
  });

  it('control: a nested mount path outside the reserved prefixes still validates', () => {
    const config = parseConfig(withMountPath('/agents/mcp'), {});
    expect(config.protocols.mcp.mountPath).toBe('/agents/mcp');
  });
});

describe('protocols.a2a', () => {
  // Give enabled adapters a resource so tests reach their intended config rule
  function withA2a(a2a: unknown): Record<string, unknown> {
    const raw = validRawConfig();
    if (a2a === undefined) delete (raw['protocols'] as Record<string, unknown>)['a2a'];
    else (raw['protocols'] as Record<string, unknown>)['a2a'] = a2a;
    if ((a2a as { enabled?: unknown } | undefined)?.enabled === true) {
      (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose.push(
        'a2a',
      );
    }
    return raw;
  }

  it('is disabled on the default mount when the block is absent', () => {
    const config = parseConfig(withA2a(undefined), {});
    expect(config.protocols.a2a).toEqual({ enabled: false, mountPath: '/a2a' });
  });

  it('applies the default mount when the block names no mountPath', () => {
    const config = parseConfig(withA2a({ enabled: true }), {});
    expect(config.protocols.a2a).toEqual({ enabled: true, mountPath: '/a2a' });
  });

  it('accepts a custom mount', () => {
    const config = parseConfig(withA2a({ enabled: true, mountPath: '/agents/a2a' }), {});
    expect(config.protocols.a2a.mountPath).toBe('/agents/a2a');
  });

  it.each([
    ['no leading slash', 'a2a', 'must start with "/"'],
    ['a Fastify parameter', '/a2a/:id', 'must not contain'],
    ['whitespace', '/a2a path', 'must not contain'],
    ['a route the gateway serves', '/health', 'must not collide'],
  ])('rejects a malformed mount: %s', (_label, mountPath, message) => {
    expectConfigInvalid(
      () => parseConfig(withA2a({ enabled: true, mountPath }), {}),
      'protocols.a2a.mountPath',
      message,
    );
  });

  // The card path is fixed by the A2A spec and served by the adapter itself
  it.each([
    ['the agent card path itself', '/.well-known/agent-card.json'],
    ['a prefix of it', '/.well-known'],
  ])('rejects %s as a configurable mount', (_label, mountPath) => {
    expectConfigInvalid(
      () => parseConfig(withA2a({ enabled: true, mountPath }), {}),
      'protocols.a2a.mountPath',
      'must not collide',
    );
    const raw = validRawConfig();
    (raw['protocols'] as { mcp: Record<string, unknown> }).mcp['mountPath'] = mountPath;
    expectConfigInvalid(() => parseConfig(raw, {}), 'protocols.mcp.mountPath', 'must not collide');
  });

  it('rejects an unknown key inside the block', () => {
    expectConfigInvalid(
      () => parseConfig(withA2a({ enabled: true, streaming: true }), {}),
      'protocols.a2a',
      /streaming/,
    );
  });

  it('accepts expose: [a2a] when enabled', () => {
    const raw = withA2a({ enabled: true });
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = [
      'http',
      'a2a',
    ];
    const config = parseConfig(raw, {});
    expect(config.resources.find((r) => r.id === 'weather_basic')?.exposedVia).toEqual([
      'http',
      'a2a',
    ]);
  });

  it('rejects enabled A2A when no resource would appear as a card skill', () => {
    const raw = withA2a({ enabled: true });
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = ['http'];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'protocols.a2a.enabled',
      'no resource lists "a2a"',
    );
  });

  it('rejects expose: [a2a] when protocols.a2a.enabled is false', () => {
    const raw = withA2a({ enabled: false });
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = ['a2a'];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.expose',
      'protocols.a2a.enabled is false',
    );
  });

  // Each mount registers a `${mountPath}/*` wildcard, so an overlap means one
  // adapter answers for the other. The mcp mount moves under `/agents` so that
  // a prefix of it is not also a prefix of a reserved gateway route.
  it.each([
    ['an identical mount', '/agents/mcp'],
    ['a mount nested under the mcp one', '/agents/mcp/a2a'],
    ['a mount the mcp one nests under', '/agents'],
  ])('rejects %s while mcp is enabled', (_label, mountPath) => {
    const raw = withA2a({ enabled: true, mountPath });
    (raw['protocols'] as { mcp: Record<string, unknown> }).mcp['mountPath'] = '/agents/mcp';
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'protocols.mcp.mountPath',
      'collides with protocols.a2a.mountPath',
    );
  });

  it('allows a colliding mount while a2a is disabled, since nothing is mounted', () => {
    const config = parseConfig(withA2a({ enabled: false, mountPath: '/mcp' }), {});
    expect(config.protocols.a2a.enabled).toBe(false);
  });
});

describe('protocols.acp', () => {
  const OPERATIONS = {
    createCheckoutSession: 'acp_checkout_create',
    updateCheckoutSession: 'acp_checkout_update',
    getCheckoutSession: 'acp_checkout_get',
    completeCheckoutSession: 'acp_checkout_complete',
    cancelCheckoutSession: 'acp_checkout_cancel',
  } as const;

  // A resource shaped like the canonical envelope the adapter sends. `optional`
  // keys are declared but not required, as a cancel's `body` must be.
  const ENVELOPE_SCHEMAS = {
    path: {
      type: 'object',
      properties: { checkout_session_id: { type: 'string' } },
      required: ['checkout_session_id'],
    },
    body: { type: 'object', additionalProperties: true },
  } as const;

  function checkoutResource(
    keys: readonly ('path' | 'body')[],
    optional: readonly 'body'[] = [],
  ): Record<string, unknown> {
    const declared = [...keys, ...optional];
    return {
      name: 'ACP checkout operation',
      input: {
        type: 'object',
        properties: Object.fromEntries(declared.map((key) => [key, ENVELOPE_SCHEMAS[key]])),
        required: [...keys],
        additionalProperties: false,
      },
      backend: {
        type: 'http',
        method: 'POST',
        url: 'http://localhost:3000/checkout',
        inputBindings: Object.fromEntries(declared.map((key) => [key, key])),
      },
      pricing: { type: 'free' },
      expose: ['acp'],
    };
  }

  // `validRawConfig` plus the five mapped ACP resources and an enabled block
  function withAcp(
    acp: Record<string, unknown> | undefined,
    resourceOverrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const raw = validRawConfig();
    const protocols = raw['protocols'] as Record<string, unknown>;
    if (acp === undefined) delete protocols['acp'];
    else protocols['acp'] = acp;

    Object.assign(raw['resources'] as Record<string, unknown>, {
      acp_checkout_create: checkoutResource(['body']),
      acp_checkout_update: checkoutResource(['path', 'body']),
      acp_checkout_get: checkoutResource(['path']),
      acp_checkout_complete: checkoutResource(['path', 'body']),
      acp_checkout_cancel: checkoutResource(['path'], ['body']),
      ...resourceOverrides,
    });
    return raw;
  }

  function enabledAcp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      enabled: true,
      auth: { type: 'bearer', token: 'secret-token' },
      idempotency: { path: './acp-idempotency.sqlite' },
      checkout: { operations: { ...OPERATIONS } },
      ...overrides,
    };
  }

  it('is disabled on the default mount when the block is absent', () => {
    const raw = validRawConfig();
    delete (raw['protocols'] as Record<string, unknown>)['acp'];
    expect(parseConfig(raw, {}).protocols.acp).toEqual({ enabled: false, mountPath: '/acp' });
  });

  it('normalizes an enabled block, defaulting the mount and the retention window', () => {
    const config = parseConfig(withAcp(enabledAcp()), {});
    expect(config.protocols.acp).toEqual({
      enabled: true,
      mountPath: '/acp',
      auth: { type: 'bearer', token: 'secret-token' },
      idempotency: {
        path: './acp-idempotency.sqlite',
        retentionHours: 24,
        merchantIdempotent: false,
      },
      checkout: { operations: OPERATIONS },
    });
  });

  it('accepts a custom mount', () => {
    const config = parseConfig(withAcp(enabledAcp({ mountPath: '/agents/acp' })), {});
    expect(config.protocols.acp.mountPath).toBe('/agents/acp');
  });

  it.each([
    ['an identical mount', '/mcp', 'protocols.mcp.mountPath', 'collides with protocols.acp'],
    ['a mount nested under the mcp one', '/mcp/acp', 'protocols.mcp.mountPath', 'collides with'],
    [
      'the acp well-known path',
      '/.well-known/acp.json',
      'protocols.acp.mountPath',
      'must not collide',
    ],
    [
      'a prefix of the acp well-known path',
      '/.well-known',
      'protocols.acp.mountPath',
      'must not collide',
    ],
  ])('rejects %s', (_label, mountPath, path, message) => {
    expectConfigInvalid(() => parseConfig(withAcp(enabledAcp({ mountPath })), {}), path, message);
  });

  it('allows a colliding mount while acp is disabled, since nothing is mounted', () => {
    const raw = validRawConfig();
    (raw['protocols'] as Record<string, unknown>)['acp'] = { enabled: false, mountPath: '/mcp' };
    expect(parseConfig(raw, {}).protocols.acp).toEqual({ enabled: false, mountPath: '/mcp' });
  });

  it.each([
    ['no auth block', { auth: undefined }, 'protocols.acp.auth'],
    ['a scheme other than bearer', { auth: { type: 'none' } }, 'protocols.acp.auth.type'],
    ['an empty token', { auth: { type: 'bearer', token: '' } }, 'protocols.acp.auth.token'],
    ['no idempotency block', { idempotency: undefined }, 'protocols.acp.idempotency'],
    ['an empty idempotency path', { idempotency: { path: '' } }, 'protocols.acp.idempotency.path'],
  ])('rejects an enabled block with %s', (_label, overrides, path) => {
    const acp = enabledAcp();
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete acp[key];
      else acp[key] = value;
    }
    expectConfigInvalid(() => parseConfig(withAcp(acp), {}), path);
  });

  // 24 hours is ACP's retry window (see ACP_RETENTION_HOURS)
  it('rejects a retention window below 24 hours', () => {
    const acp = enabledAcp({ idempotency: { path: './acp.sqlite', retentionHours: 23 } });
    expectConfigInvalid(
      () => parseConfig(withAcp(acp), {}),
      'protocols.acp.idempotency.retentionHours',
      '>= 24',
    );
  });

  it('accepts a longer retention window, including as an env-substituted string', () => {
    const acp = enabledAcp({
      idempotency: { path: './acp.sqlite', retentionHours: '${ACP_RETENTION}' },
    });
    const config = parseConfig(withAcp(acp), { ACP_RETENTION: '72' });
    expect(config.protocols.acp.enabled && config.protocols.acp.idempotency.retentionHours).toBe(
      72,
    );
  });

  it('rejects an unknown key inside the block', () => {
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp({ webhooks: true })), {}),
      'protocols.acp',
      /webhooks/,
    );
  });

  it('rejects a partially mapped checkout lifecycle', () => {
    const operations: Record<string, string> = { ...OPERATIONS };
    delete operations['cancelCheckoutSession'];
    const acp = enabledAcp({ checkout: { operations } });
    expectConfigInvalid(
      () => parseConfig(withAcp(acp), {}),
      'protocols.acp.checkout.operations.cancelCheckoutSession',
      'all five checkout operations must be mapped',
    );
  });

  it('rejects an unknown operation id', () => {
    const acp = enabledAcp({
      checkout: { operations: { ...OPERATIONS, refundCheckoutSession: 'acp_checkout_create' } },
    });
    expectConfigInvalid(
      () => parseConfig(withAcp(acp), {}),
      'protocols.acp.checkout.operations.refundCheckoutSession',
      'unknown ACP checkout operation',
    );
  });

  it('rejects one resource mapped to two operations', () => {
    const acp = enabledAcp({
      checkout: { operations: { ...OPERATIONS, getCheckoutSession: 'acp_checkout_create' } },
    });
    expectConfigInvalid(
      () => parseConfig(withAcp(acp), {}),
      'protocols.acp.checkout.operations.getCheckoutSession',
      'already mapped to "createCheckoutSession"',
    );
  });

  it('rejects a mapping naming a resource that does not exist', () => {
    const acp = enabledAcp({
      checkout: { operations: { ...OPERATIONS, getCheckoutSession: 'nope' } },
    });
    expectConfigInvalid(
      () => parseConfig(withAcp(acp), {}),
      'protocols.acp.checkout.operations.getCheckoutSession',
      'not defined under "resources"',
    );
  });

  it('rejects a mapped resource that does not expose acp', () => {
    const resource = checkoutResource(['path']);
    resource['expose'] = ['http'];
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_get: resource }), {}),
      'protocols.acp.checkout.operations.getCheckoutSession',
      'does not list "acp" in its expose',
    );
  });

  // ACP checkout carries its own purchase payment, so the invocation is free
  it.each([
    ['priced', { type: 'fixed', amount: '0.01', currency: 'USDC' }],
    ['free but naming a rail', { type: 'free' }],
  ])('rejects a mapped resource that is %s', (_label, pricing) => {
    const resource = checkoutResource(['path']);
    resource['pricing'] = pricing;
    resource['payments'] = ['x402'];
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_get: resource }), {}),
      'protocols.acp.checkout.operations.getCheckoutSession',
      'must use pricing.type "free" with no "payments"',
    );
  });

  it('rejects a mapped resource whose input schema forbids a key ACP always sends', () => {
    // No bindings: a binding to the undeclared `path` would be refused first
    const resource = checkoutResource([]);
    delete (resource['backend'] as Record<string, unknown>)['inputBindings'];
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_get: resource }), {}),
      'protocols.acp.checkout.operations.getCheckoutSession',
      'additionalProperties: false without declaring "path"',
    );
  });

  it('rejects a mapped resource requiring input the operation does not always send', () => {
    // A bare cancel sends no body: the pinned ACP schema does not require one
    const resource = checkoutResource(['path', 'body']);
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_cancel: resource }), {}),
      'protocols.acp.checkout.operations.cancelCheckoutSession',
      'requires "body"',
    );
  });

  it('rejects a closed cancel schema that does not declare the optional body', () => {
    // It would pass a bare cancel and refuse every cancel carrying `intent_trace`
    const resource = checkoutResource(['path']);
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_cancel: resource }), {}),
      'protocols.acp.checkout.operations.cancelCheckoutSession',
      'without declaring "body"',
    );
  });

  it('accepts a cancel schema that leaves the body open or declares it optional', () => {
    const open = checkoutResource(['path']);
    (open['input'] as { additionalProperties: boolean }).additionalProperties = true;
    expect(() =>
      parseConfig(withAcp(enabledAcp(), { acp_checkout_cancel: open }), {}),
    ).not.toThrow();
    expect(() =>
      parseConfig(
        withAcp(enabledAcp(), { acp_checkout_cancel: checkoutResource(['path'], ['body']) }),
        {},
      ),
    ).not.toThrow();
  });

  // Load closes an object node that omits additionalProperties, so this body
  // would accept no key and refuse every ACP document with INPUT_INVALID
  it('rejects a bare body: { type: object }, which load closes', () => {
    const resource = checkoutResource(['body']);
    (resource['input'] as { properties: Record<string, unknown> }).properties['body'] = {
      type: 'object',
    };
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_create: resource }), {}),
      'protocols.acp.checkout.operations.createCheckoutSession',
      'its "body" schema accepts no keys',
    );
  });

  it('accepts a closed body that declares the document fields', () => {
    const resource = checkoutResource(['body']);
    (resource['input'] as { properties: Record<string, unknown> }).properties['body'] = {
      type: 'object',
      properties: {
        line_items: { type: 'array' },
        currency: { type: 'string' },
        capabilities: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    };
    expect(() =>
      parseConfig(withAcp(enabledAcp(), { acp_checkout_create: resource }), {}),
    ).not.toThrow();
  });

  it('rejects a closed path schema that does not declare checkout_session_id', () => {
    // The backend URL is not templated, so the path-binding rule does not fire
    const resource = checkoutResource(['path']);
    (resource['input'] as { properties: Record<string, unknown> }).properties['path'] = {
      type: 'object',
    };
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_get: resource }), {}),
      'protocols.acp.checkout.operations.getCheckoutSession',
      'its "path" schema sets additionalProperties: false without declaring "checkout_session_id"',
    );
  });

  it('rejects an input schema with no properties at all, which load closes', () => {
    const resource = checkoutResource(['body']);
    resource['input'] = { type: 'object' };
    delete (resource['backend'] as Record<string, unknown>)['inputBindings'];
    expectConfigInvalid(
      () => parseConfig(withAcp(enabledAcp(), { acp_checkout_create: resource }), {}),
      'protocols.acp.checkout.operations.createCheckoutSession',
      'without declaring "body"',
    );
  });

  it('rejects expose: [acp] when protocols.acp.enabled is false', () => {
    const raw = validRawConfig();
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = ['acp'];
    expectConfigInvalid(
      () => parseConfig(raw, {}),
      'resources.weather_basic.expose',
      'protocols.acp.enabled is false',
    );
  });

  it('keeps optional discovery metadata only when configured', () => {
    const plain = parseConfig(withAcp(enabledAcp()), {});
    expect(plain.protocols.acp.enabled && plain.protocols.acp.discovery).toBeUndefined();

    const described = parseConfig(
      withAcp(
        enabledAcp({
          discovery: { supportedCurrencies: ['usd'], documentationUrl: 'https://example.com/acp' },
        }),
      ),
      {},
    );
    expect(described.protocols.acp.enabled && described.protocols.acp.discovery).toEqual({
      documentationUrl: 'https://example.com/acp',
      supportedCurrencies: ['usd'],
    });
  });
});

describe('parseConfig backend.inputBindings', () => {
  // A config whose one resource is an OpenAPI-shaped path + query + body POST
  function bindingConfig(
    overrides: {
      readonly bindings?: unknown;
      readonly method?: string;
      readonly url?: string;
      readonly input?: unknown;
    } = {},
  ): Record<string, unknown> {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, unknown>;
    raw['resources'] = {
      create_order: {
        name: 'Create Order',
        input: overrides.input ?? {
          type: 'object',
          properties: {
            path: {
              type: 'object',
              properties: { userId: { type: 'string' } },
              required: ['userId'],
            },
            query: { type: 'object', properties: { notify: { type: 'boolean' } } },
            body: { type: 'object', properties: { productId: { type: 'string' } } },
          },
          required: ['path'],
          additionalProperties: false,
        },
        backend: {
          type: 'http',
          method: overrides.method ?? 'POST',
          url: overrides.url ?? 'http://localhost:3000/users/{userId}/orders',
          ...(overrides.bindings !== undefined ? { inputBindings: overrides.bindings } : {}),
        },
        pricing: { type: 'free' },
        expose: ['http'],
      },
      market_report: resources['market_report'],
    };
    return raw;
  }

  const bindings = { path: 'path', query: 'query', body: 'body' };

  it('parses the block and normalizes it onto the canonical handler', () => {
    const config = parseConfig(bindingConfig({ bindings }), {});
    const resource = config.resources.find((r) => r.id === 'create_order');
    expect(resource?.handler.inputBindings).toEqual(bindings);
  });

  it('leaves the handler unbound when the block is absent (existing configs)', () => {
    const config = parseConfig(validRawConfig(), {});
    for (const resource of config.resources) {
      expect(resource.handler.inputBindings).toBeUndefined();
    }
  });

  it('omits absent binding keys rather than setting them undefined', () => {
    const config = parseConfig(bindingConfig({ bindings: { path: 'path' } }), {});
    const resource = config.resources.find((r) => r.id === 'create_order');
    expect(Object.keys(resource?.handler.inputBindings ?? {})).toEqual(['path']);
  });

  const BINDINGS_PATH = 'resources.create_order.backend.inputBindings';

  it('rejects an unknown binding location (typo)', () => {
    expectConfigInvalid(
      () => parseConfig(bindingConfig({ bindings: { ...bindings, bodyy: 'body' } }), {}),
      BINDINGS_PATH,
      /bodyy/,
    );
  });

  it('rejects an empty binding block', () => {
    expectConfigInvalid(
      () => parseConfig(bindingConfig({ bindings: {} }), {}),
      BINDINGS_PATH,
      'empty backend.inputBindings',
    );
  });

  it('rejects a binding to a property the input schema never declares', () => {
    expectConfigInvalid(
      () => parseConfig(bindingConfig({ bindings: { ...bindings, query: 'filters' } }), {}),
      BINDINGS_PATH,
      'input property "filters", which the input schema does not declare',
    );
  });

  it('rejects a path or query binding pointing at a non-object schema', () => {
    expectConfigInvalid(
      () =>
        parseConfig(
          bindingConfig({
            bindings,
            input: {
              type: 'object',
              properties: {
                path: {
                  type: 'object',
                  properties: { userId: { type: 'string' } },
                  required: ['userId'],
                },
                query: { type: 'string' },
                body: { type: 'object' },
              },
              required: ['path'],
            },
          }),
          {},
        ),
      BINDINGS_PATH,
      'input property "query", which is not an object schema',
    );
  });

  it('rejects two locations bound to the same input property', () => {
    expectConfigInvalid(
      () => parseConfig(bindingConfig({ bindings: { path: 'path', query: 'path' } }), {}),
      BINDINGS_PATH,
      'binds both "path" and "query"',
    );
  });

  it.each(RESERVED_INPUT_FIELDS)('rejects a binding to the reserved "%s" input field', (field) => {
    expectConfigInvalid(
      () => parseConfig(bindingConfig({ bindings: { ...bindings, body: field } }), {}),
      BINDINGS_PATH,
      `"${field}", which is reserved`,
    );
  });

  it('rejects a body binding on a method that sends no body', () => {
    expectConfigInvalid(
      () =>
        parseConfig(
          bindingConfig({
            bindings,
            method: 'GET',
            url: 'http://localhost:3000/users/{userId}',
          }),
          {},
        ),
      BINDINGS_PATH,
      'binds a request body on a GET',
    );
  });

  it('rejects explicit bindings that omit "path" while backend.url is templated', () => {
    expectConfigInvalid(
      () => parseConfig(bindingConfig({ bindings: { query: 'query', body: 'body' } }), {}),
      BINDINGS_PATH,
      'no "path" binding',
    );
  });

  it('rejects a path group that is not itself required', () => {
    expectConfigInvalid(
      () =>
        parseConfig(
          bindingConfig({
            bindings,
            input: {
              type: 'object',
              properties: {
                path: {
                  type: 'object',
                  properties: { userId: { type: 'string' } },
                  required: ['userId'],
                },
                query: { type: 'object' },
                body: { type: 'object' },
              },
              required: [],
            },
          }),
          {},
        ),
      BINDINGS_PATH,
      'binds path parameters to input property "path" without listing it',
    );
  });

  it('rejects a {param} that is not declared inside the bound path group', () => {
    expectConfigInvalid(
      () =>
        parseConfig(
          bindingConfig({
            bindings,
            // userId at the top level; with bindings, path parameters are read
            // only from the path group
            input: {
              type: 'object',
              properties: {
                userId: { type: 'string' },
                path: { type: 'object', properties: {}, required: [] },
                query: { type: 'object' },
                body: { type: 'object' },
              },
              required: ['path', 'userId'],
            },
          }),
          {},
        ),
      'resources.create_order.backend.url',
      '"{userId}" which is not declared in input.properties.path',
    );
  });

  it('rejects a nested {param} that is declared but not required', () => {
    expectConfigInvalid(
      () =>
        parseConfig(
          bindingConfig({
            bindings,
            input: {
              type: 'object',
              properties: {
                path: { type: 'object', properties: { userId: { type: 'string' } }, required: [] },
                query: { type: 'object' },
                body: { type: 'object' },
              },
              required: ['path'],
            },
          }),
          {},
        ),
      'resources.create_order.backend.url',
      '"{userId}" declared in input.properties.path but not listed in its "required"',
    );
  });

  it('accepts the normalized handler as input to the pre-payment shape check', () => {
    const config = parseConfig(bindingConfig({ bindings }), {});
    const resource = config.resources.find((r) => r.id === 'create_order');
    expect(resource).toBeDefined();
    if (!resource) return;
    expect(() =>
      validateBackendRequestShape(
        resource.handler,
        { path: { userId: 'u-1' }, query: { notify: true }, body: { productId: 'abc' } },
        { requestId: 'r', resourceId: resource.id },
      ),
    ).not.toThrow();
  });
});

describe('payments.mpp', () => {
  const SECRET = 'mpp-challenge-secret-'.padEnd(32, 'x');

  // MPP-only config with no x402 block
  function mppConfig(mpp: Record<string, unknown> = {}): Record<string, unknown> {
    const raw = validRawConfig();
    raw['payments'] = {
      mpp: {
        enabled: true,
        rpcUrl: 'https://sepolia.example/v2/key',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        assetName: 'USDC',
        assetVersion: '2',
        recipient: '0x1111111111111111111111111111111111111111',
        realm: 'api.example.com',
        challengeSecret: SECRET,
        facilitator: { mode: 'remote', url: 'https://facilitator.example' },
        ...mpp,
      },
    };
    (raw['resources'] as { market_report: { payments: string[] } }).market_report.payments = [
      'mpp',
    ];
    return raw;
  }

  it('loads an MPP-only deployment without any x402 block', () => {
    const config = parseConfig(mppConfig({ challengeTtlSeconds: '120' }), {});
    expect(config.payments.x402).toBeUndefined();
    expect(config.payments.mpp).toMatchObject({
      enabled: true,
      challengeTtlSeconds: 120,
      facilitator: { mode: 'remote', auth: { type: 'none' } },
    });
    expect(config.resources.find((r) => r.id === 'market_report')?.paymentMethods).toEqual(['mpp']);
  });

  it('refuses a resource whose only rail is a disabled MPP block', () => {
    expectConfigInvalid(
      () => parseConfig(mppConfig({ enabled: false }), {}),
      'resources.market_report.payments',
    );
  });

  it('refuses a challenge secret with length below 32 without echoing it', () => {
    const error = expectConfigInvalid(
      () => parseConfig(mppConfig({ challengeSecret: 'short-secret' }), {}),
      'payments.mpp.challengeSecret',
    );
    expect(JSON.stringify(error.toInfo())).not.toContain('short-secret');
  });

  it.each([
    ['a multi-line realm', { realm: 'api.example.com\nX-Evil: 1' }, 'payments.mpp.realm'],
    ['a recipient that is not an address', { recipient: '0x1234' }, 'payments.mpp.recipient'],
    ['a zero TTL', { challengeTtlSeconds: 0 }, 'payments.mpp.challengeTtlSeconds'],
    [
      'a well-known dev recipient on a public deployment',
      { recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
      'payments.mpp.recipient',
    ],
    [
      'a plain-HTTP public facilitator',
      { facilitator: { mode: 'remote', url: 'http://facilitator.example' } },
      'payments.mpp.facilitator.url',
    ],
  ])('refuses %s, naming the MPP field', (_label, mpp, path) => {
    expectConfigInvalid(() => parseConfig(mppConfig(mpp), {}), path);
  });

  it('refuses an unknown key in the MPP block', () => {
    expectConfigInvalid(
      () => parseConfig(mppConfig({ currency: 'EUR' }), {}),
      'payments.mpp',
      /currency/,
    );
  });

  it('refuses an unsupported MPP network', () => {
    expectConfigInvalid(
      () => parseConfig(mppConfig({ network: 'eip155:1' }), {}),
      'payments.mpp.network',
    );
  });

  describe('on Base mainnet', () => {
    const MAINNET = {
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      assetName: 'USD Coin',
      allowMainnet: true,
      facilitator: {
        mode: 'remote',
        url: 'https://facilitator.example',
        auth: { type: 'bearer', token: 'facilitator-token' },
      },
    };

    it('loads with an explicit opt-in, canonical USDC and an authenticated remote facilitator', () => {
      expect(parseConfig(mppConfig(MAINNET), {}).payments.mpp).toMatchObject({
        network: 'eip155:8453',
        allowMainnet: true,
      });
    });

    it.each([
      ['no allowMainnet', { allowMainnet: undefined }, 'payments.mpp.allowMainnet'],
      [
        'a local facilitator',
        { facilitator: { mode: 'local', signerPrivateKey: `0x${'1'.repeat(64)}` } },
        'payments.mpp.facilitator.mode',
      ],
      [
        'an asset other than canonical USDC',
        { asset: '0x2222222222222222222222222222222222222222' },
        'payments.mpp.asset',
      ],
      ["Base Sepolia's EIP-712 name", { assetName: 'USDC' }, 'payments.mpp.assetName'],
      [
        'a facilitator with no credential and no explicit acceptance',
        { facilitator: { mode: 'remote', url: 'https://facilitator.example' } },
        'payments.mpp.allowUnauthenticatedFacilitator',
      ],
    ])('refuses %s', (_label, change, path) => {
      const mpp = { ...MAINNET, ...change };
      if (mpp.allowMainnet === undefined) delete (mpp as Record<string, unknown>)['allowMainnet'];
      expectConfigInvalid(() => parseConfig(mppConfig(mpp), {}), path);
    });
  });

  it('refuses an MPP resource priced in anything but USDC', () => {
    const raw = mppConfig();
    const report = (raw['resources'] as Record<string, Record<string, unknown>>)['market_report'];
    (report as Record<string, unknown>)['pricing'] = {
      type: 'fixed',
      amount: '0.01',
      currency: 'EUR',
    };
    expectConfigInvalid(() => parseConfig(raw, {}), 'resources.market_report.pricing.currency');
  });

  it('refuses an MPP price with more precision than USDC has', () => {
    const raw = mppConfig();
    const report = (raw['resources'] as Record<string, Record<string, unknown>>)['market_report'];
    (report as Record<string, unknown>)['pricing'] = {
      type: 'fixed',
      amount: '0.0000001',
      currency: 'USDC',
    };
    expectConfigInvalid(() => parseConfig(raw, {}), 'resources.market_report.pricing.amount');
  });
});
