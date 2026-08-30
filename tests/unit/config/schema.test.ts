import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../../src/config/schema.js';
import {
  compileJsonSchema,
  validateBackendRequestShape,
} from '../../../src/core/execution/index.js';
import { isCommerceError, PAYMENT_INPUT_FIELD } from '../../../src/core/index.js';
import { validRawConfig } from './fixtures.js';

function expectConfigInvalid(fn: () => unknown): void {
  expect(fn).toThrowError();
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    if (isCommerceError(error)) {
      expect(error.code).toBe('CONFIG_INVALID');
    }
  }
}

describe('parseConfig', () => {
  it('accepts a valid config and normalises resources to a canonical array', () => {
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
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('$');
        expect(JSON.stringify(error.details)).toContain('unrecognized_keys');
      }
    }
  });

  it('rejects an unknown nested key with a clear path', () => {
    const raw = validRawConfig();
    (raw['merchant'] as Record<string, unknown>)['extra'] = 'nope';
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('merchant');
      }
    }
  });

  it('rejects a config missing a required field', () => {
    const raw = validRawConfig();
    delete (raw['merchant'] as Record<string, unknown>)['id'];
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects an unsupported config version with a clear message', () => {
    const raw = { ...validRawConfig(), version: 2 };
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message.toLowerCase()).toContain('unsupported config version');
      }
    }
  });

  it('rejects a config missing the version field entirely', () => {
    const raw = validRawConfig();
    delete raw['version'];
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects pricing.type "dynamic" with an explicit not-supported message', () => {
    const raw = validRawConfig();
    (raw['resources'] as Record<string, unknown>)['dynamic_res'] = {
      name: 'Dynamic',
      backend: { type: 'http', method: 'GET', url: 'http://localhost:3000/x' },
      pricing: { type: 'dynamic', resolver: 'some-resolver' },
      expose: ['http'],
    };
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('not supported in this release');
      }
    }
  });

  it('rejects malformed pricing.amount values that pass a bare string schema but fail every purchase', () => {
    const malformed = ['0,01', '$0.01', '1e-2', '-1'];
    for (const amount of malformed) {
      const raw = validRawConfig();
      (
        raw['resources'] as { market_report: { pricing: Record<string, unknown> } }
      ).market_report.pricing['amount'] = amount;
      expectConfigInvalid(() => parseConfig(raw, {}));
      try {
        parseConfig(raw, {});
      } catch (error) {
        if (isCommerceError(error)) {
          expect(error.message, `expected "${amount}" to be rejected`).toContain(
            'plain positive decimal',
          );
        }
      }
    }
  });

  it('rejects pricing.amount "0" explicitly, pointing at pricing: { type: free }', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { pricing: Record<string, unknown> } }
    ).market_report.pricing['amount'] = '0';
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('cannot cost zero');
        expect(error.message).toContain('type: free');
      }
    }
  });

  it('rejects pricing.amount with more fractional digits than the asset can represent', () => {
    const raw = validRawConfig();
    // assetDecimals in validRawConfig() is 6.
    (
      raw['resources'] as { market_report: { pricing: Record<string, unknown> } }
    ).market_report.pricing['amount'] = '0.0000001';
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('more precision');
      }
    }
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

    /**
     * Every other defence around `{param}` guards the path position, and in the
     * host position all of them fail open at once: `new URL('http://{host}/api')`
     * parses so the URL check passes; the runtime containment check is skipped
     * because its literal prefix (`http://`) does not itself parse as a URL; and
     * `encodeURIComponent` does not escape dots, so a hostname survives whole.
     * Caller input would then choose which host the gateway calls — the cloud
     * metadata service, an internal address, anything.
     */
    it.each([
      ['the whole host', 'http://{host}/api'],
      ['a host prefix', 'http://{tenant}.api.internal/v1'],
      ['host and port', 'http://{host}:8080/api'],
    ])('refuses a parameter that spans %s', (_label, url) => {
      expectConfigInvalid(() => parseConfig(withBackendUrl(url), {}));
      try {
        parseConfig(withBackendUrl(url), {});
      } catch (error) {
        if (isCommerceError(error)) {
          expect(error.message).toContain('before the end of the host');
        }
      }
    });

    it('refuses a parameter in the scheme, via the absolute-URL check', () => {
      // Refused one check earlier: `{scheme}://…` parses with protocol
      // `{scheme}:`, which is neither http nor https. Same outcome, different
      // message, and asserted separately so a change to either is visible.
      expectConfigInvalid(() => parseConfig(withBackendUrl('{scheme}://backend.local/api'), {}));
    });

    it.each([
      ['a path segment', 'http://backend.local/user/{host}'],
      ['a query value', 'http://backend.local/search?q={host}'],
      ['the whole path', 'http://backend.local/{host}'],
    ])('still accepts a parameter in %s', (_label, url) => {
      expect(() => parseConfig(withBackendUrl(url), {})).not.toThrow();
    });
  });

  describe('closed-schema stamping', () => {
    /**
     * The stamper's third drift from the validator, after `required` and tuple
     * `items`. `additionalProperties: {schema}` is the idiomatic "map of typed
     * objects" shape and the validator applies that subschema recursively — so
     * without recursion here, every node beneath it stayed open and unknown
     * keys reached the merchant's backend.
     */
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
        return isCommerceError(error) ? error.message : String(error);
      }
      throw new Error('expected parseConfig to reject this configuration');
    }

    it('accepts a remote facilitator on a testnet', () => {
      const config = parseConfig(
        withX402({
          payTo: MERCHANT,
          facilitator: { mode: 'remote', url: 'https://facilitator.example.com' },
        }),
        {},
      );
      // Absent auth is normalised to an explicit "no credential", so nothing
      // downstream has to decide what `undefined` meant.
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
      // The local facilitator signs with a key this process holds — a hot
      // wallet inside the resource server, which is the arrangement this
      // project exists to avoid.
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
      // The origin, so an operator can see *which* counterparty they are being
      // asked about — but never the path, which can carry a tenant or a key.
      expect(message).toContain('https://facilitator.example.com');
      expect(message).not.toContain('/v2/x402');

      // Accepting it explicitly is allowed. It is a real choice, not a bug.
      const config = parseConfig(
        withX402({ ...unauthenticated, allowUnauthenticatedFacilitator: true }),
        {},
      );
      expect(config.payments.x402?.allowUnauthenticatedFacilitator).toBe(true);
    });

    it('does not let allowUnauthenticatedFacilitator stand in for allowMainnet', () => {
      // Two different decisions: "I meant to use real money" and "I accept
      // this counterparty". Neither implies the other.
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

    it('needs no acknowledgement for an unauthenticated facilitator below mainnet', () => {
      // The public testnet facilitator takes no credential and never will.
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
      // A dot-free host is a compose/k8s service name — the traffic never
      // leaves the deployment, so requiring TLS there would only block the
      // normal self-hosted arrangement.
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
      // The fixture's payTo is Anvil account #1 — fine locally, catastrophic
      // anywhere the money is real, because its private key is public.
      const message = messageFor(
        withX402({ facilitator: { mode: 'remote', url: 'https://facilitator.example.com' } }),
      );
      expect(message).toContain('well-known Anvil development address');
    });

    it('rejects a mainnet assetName that is not the EIP-712 domain the token reports', () => {
      // Base mainnet USDC reports "USD Coin"; Base Sepolia's reports "USDC".
      // The name is signed into the buyer's domain, so the obvious-looking
      // value gets every payment refused *after* they signed.
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
      expect(() =>
        parseConfig(
          withX402({
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
          }),
          {},
        ),
      ).not.toThrow();
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
      // Below mainnet a dot-free host is a compose service name and the
      // traffic never leaves the deployment. On mainnet nothing earns that.
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
      const message = messageFor(
        withX402({
          payTo: MERCHANT,
          facilitator: {
            mode: 'remote',
            url: 'https://facilitator.example.com',
            auth: { type: 'hmac', secret: 's' },
          },
        }),
      );
      expect(message).toContain('payments.x402.facilitator');
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
      expect(messageFor(raw)).toContain('empty');
    });
  });

  it(`rejects a resource whose input.properties declares the reserved "${PAYMENT_INPUT_FIELD}" field`, () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { weather_basic: { input: { properties: Record<string, unknown> } } }
    ).weather_basic.input.properties[PAYMENT_INPUT_FIELD] = { type: 'string' };
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain(PAYMENT_INPUT_FIELD);
        expect(error.message).toContain('reserved');
      }
    }
  });

  it('rejects a paid resource declaring no payment methods', () => {
    const raw = validRawConfig();
    (raw['resources'] as Record<string, unknown>)['broken'] = {
      name: 'Broken',
      backend: { type: 'http', method: 'GET', url: 'http://localhost:3000/x' },
      pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
      expose: ['http'],
    };
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('broken');
      }
    }
  });

  it('rejects an mcp-exposed resource whose id is not a legal MCP tool name', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, unknown>;
    resources['weather/basic bad id'] = resources['weather_basic'];
    delete resources['weather_basic'];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('legal MCP tool name');
      }
    }
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
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('http');
      }
    }
  });

  it('rejects a malformed backend.url', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { weather_basic: { backend: Record<string, unknown> } }
    ).weather_basic.backend['url'] = 'not a url at all';
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects a paid, {param}-templated resource whose input: is missing entirely — the caller could never supply it, so every call would settle payment and never reach the backend', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    delete weather['input'];
    weather['pricing'] = { type: 'fixed', amount: '0.01', currency: 'USDC' };
    weather['payments'] = ['x402'];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('{city}');
        expect(error.message).toContain('not declared');
      }
    }
  });

  it('rejects the same resource when {city} is declared but not required (optional) — a caller that omits it hits the identical bug', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    weather['input'] = {
      type: 'object',
      properties: { city: { type: 'string' } },
      additionalProperties: false,
      // no `required` — this is the trap: declared, but still unenforceable.
    };
    weather['pricing'] = { type: 'fixed', amount: '0.01', currency: 'USDC' };
    weather['payments'] = ['x402'];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('{city}');
        expect(error.message).toContain('required');
      }
    }
  });

  it.each([
    ['a wildcard', '*'],
    ['a trailing slash', 'http://localhost:5173/'],
  ])(
    'rejects an allowedOrigins entry with %s — it is matched literally and would never match',
    (_label, origin) => {
      // Fail-closed (a lockout, not a bypass) but silent, and a lockout with
      // no explanation is what an operator "fixes" by disabling the check.
      const raw = validRawConfig();
      (raw['server'] as Record<string, unknown>)['allowedOrigins'] = [origin];
      expectConfigInvalid(() => parseConfig(raw, {}));
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
  ])('rejects server.port given as %s — Number() would coerce it silently', (_label, port) => {
    // `Number('')` is 0: finite, integral, and inside port's deliberate
    // `min: 0` ("let the OS pick"). So `port: ${PORT:-}` validated PASS, the
    // gateway bound a random port, and `doctor` then derived
    // `http://127.0.0.1:0` and reported the running gateway unreachable.
    const raw = validRawConfig();
    (raw['server'] as Record<string, unknown>)['port'] = port;
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('control: decimal digits, as a string or a number, still work — including 0 meaning "let the OS pick"', () => {
    for (const port of ['8080', 8080, '0', 0]) {
      const raw = validRawConfig();
      (raw['server'] as Record<string, unknown>)['port'] = port;
      expect(parseConfig(raw, {}).server.port).toBe(Number(port));
    }
  });

  it('stamps additionalProperties:false on a node that declares only "required" — core treats it as an object, so config must too', () => {
    // The two definitions of "this is an object schema" were one keyword
    // apart: config looked at type/properties, core at properties/required.
    // `input: { required: ['q'] }` was an object to the validator and not to
    // the stamper, so it normalised to exactly {"required":["q"]} and every
    // unknown caller key was forwarded verbatim to the merchant's backend —
    // while docs/security.md promised closed-by-default at every level.
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

  it('rejects a "required" name that "properties" never declares — closing it makes the schema unsatisfiable by any input', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    (weather['backend'] as Record<string, unknown>)['url'] = 'http://localhost:3000/api/weather';
    weather['input'] = { required: ['q'] };
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('"q"');
        expect(error.message).toContain('no input can ever satisfy');
      }
    }
  });

  it('control: an explicit additionalProperties:true is left open — the operator opted in', () => {
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

  it('rejects a paid resource whose {param} uses a kebab name — it matched no grammar, so the gate saw zero parameters and passed', () => {
    // The regression that reopened the earlier money bug through the character
    // class rather than through the check. `{report-id}` is ordinary REST.
    // Under `[a-zA-Z0-9_]+` it matched nothing: the gate found no parameters
    // and returned early, `applyPathTemplate` substituted nothing, and the
    // backend received `/report/%7Breport-id%7D`. Every call: buyer charged
    // on-chain, nothing delivered, replay key burned.
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const report = resources['market_report'] as Record<string, unknown>;
    (report['backend'] as Record<string, unknown>)['url'] =
      'http://localhost:3000/api/report/{report-id}';
    delete report['input'];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('{report-id}');
        expect(error.message).toContain('not declared');
      }
    }
  });

  it.each([
    ['a space', 'http://localhost:3000/api/report/{report id}'],
    ['a slash', 'http://localhost:3000/api/report/{a/b}'],
    ['nothing at all', 'http://localhost:3000/api/report/{}'],
    ['an unbalanced brace', 'http://localhost:3000/api/report/{oops'],
  ])(
    'rejects a brace token containing %s — widening the grammar cannot cover every spelling, so anything brace-shaped that is not a parameter is refused',
    (_label, url) => {
      const raw = validRawConfig();
      const resources = raw['resources'] as Record<string, Record<string, unknown>>;
      const report = resources['market_report'] as Record<string, unknown>;
      (report['backend'] as Record<string, unknown>)['url'] = url;
      expectConfigInvalid(() => parseConfig(raw, {}));
      try {
        parseConfig(raw, {});
      } catch (error) {
        if (isCommerceError(error)) {
          expect(error.message).toContain('not a valid path parameter');
        }
      }
    },
  );

  it('control: a kebab {param} that IS declared and required loads and stays servable — the fix must not reject ordinary REST', () => {
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

  it('control: a paid, {param}-templated resource with city correctly required still loads — do not over-reject', () => {
    const raw = validRawConfig();
    const resources = raw['resources'] as Record<string, Record<string, unknown>>;
    const weather = resources['weather_basic'] as Record<string, unknown>;
    // fixtures.ts's weather_basic already declares `required: [city]` — only
    // switch it to paid, which is the shape the money bug actually needs.
    weather['pricing'] = { type: 'fixed', amount: '0.01', currency: 'USDC' };
    weather['payments'] = ['x402'];
    const config = parseConfig(raw, {});
    expect(config.resources.some((r) => r.id === 'weather_basic')).toBe(true);
  });

  it('rejects a resource naming an unsupported payment method', () => {
    const raw = validRawConfig();
    (raw['resources'] as { market_report: { payments: string[] } }).market_report.payments = [
      'stripe',
    ];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('stripe');
      }
    }
  });

  it('rejects a value below the minimum bound (maxTimeoutSeconds)', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['maxTimeoutSeconds'] = 0;
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects a value above the maximum bound (assetDecimals)', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['assetDecimals'] = 100;
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects a resource naming a payment method that is not configured', () => {
    const raw = validRawConfig();
    delete (raw['payments'] as Record<string, unknown>)['x402'];
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects a paid resource when payments.x402.enabled is false', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['enabled'] = false;
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('x402');
      }
    }
  });

  it('rejects an expose value outside [http, mcp, a2a], mentioning UCP is planned', () => {
    const raw = validRawConfig();
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = [
      'http',
      'ucp',
    ];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('UCP');
        expect(error.message).toContain('planned');
      }
    }
  });

  it('rejects an unknown expose value that is not ucp too, without the UCP hint', () => {
    const raw = validRawConfig();
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = [
      'http',
      'grpc',
    ];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).not.toContain('UCP');
      }
    }
  });

  it('rejects an expose:[mcp] resource when protocols.mcp.enabled is false', () => {
    const raw = validRawConfig();
    (raw['protocols'] as { mcp: Record<string, unknown> }).mcp['enabled'] = false;
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('mcp');
      }
    }
  });

  it('rejects an expose:[http] resource when protocols.http.enabled is false', () => {
    const raw = validRawConfig();
    (raw['protocols'] as { http: Record<string, unknown> }).http['enabled'] = false;
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects an invalid (not 0x + 40 hex) payTo', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['payTo'] = 'not-an-address';
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects the zero address as payTo', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['payTo'] =
      '0x0000000000000000000000000000000000000000';
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects an invalid asset address', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['asset'] = '0xshort';
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('accepts a lowercase or uppercase address (checksum-insensitive)', () => {
    const raw = validRawConfig();
    (raw['payments'] as { x402: Record<string, unknown> }).x402['payTo'] =
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const config = parseConfig(raw, {});
    expect(config.payments.x402?.payTo).toBe('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
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

  it('rejects a schema declaring properties/required whose type excludes "object" — the validator would never enforce either', () => {
    const raw = validRawConfig();
    (
      raw['resources'] as { market_report: { input: Record<string, unknown> } }
    ).market_report.input = {
      type: 'string', // copy-paste-stale: properties/required imply object
      properties: { city: { type: 'string' } },
      required: ['city'],
    };
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('does not include "object"');
      }
    }
  });

  it('control: properties/required with NO type at all still loads — the validator treats that as an object schema now', () => {
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
          // no additionalProperties here — this is the bug: the root gets
          // closed, this level did not.
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

  it('coerces numeric fields supplied as strings (post env-substitution)', () => {
    const raw = validRawConfig();
    (raw['server'] as Record<string, unknown>)['port'] = '9090';
    const config = parseConfig(raw, {});
    expect(config.server.port).toBe(9090);
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
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects a port out of range', () => {
    const raw = validRawConfig();
    (raw['server'] as Record<string, unknown>)['port'] = 70000;
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects a garbage boolean string', () => {
    const raw = validRawConfig();
    (raw['protocols'] as { http: Record<string, unknown> }).http['enabled'] = 'maybe';
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects a non-object config root', () => {
    expectConfigInvalid(() => parseConfig('not-an-object', {}));
    expectConfigInvalid(() => parseConfig(null, {}));
    expectConfigInvalid(() => parseConfig([1, 2, 3], {}));
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
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('GATEWAY_PUBLIC_BASE_URL');
      }
    }
  });

  it('resolves ${VAR:-default} to the default when VAR is unset', () => {
    const raw = validRawConfig();
    (raw['merchant'] as Record<string, unknown>)['publicBaseUrl'] =
      '${GATEWAY_PUBLIC_BASE_URL:-http://localhost:8080}';
    const config = parseConfig(raw, {});
    expect(config.merchant.publicBaseUrl).toBe('http://localhost:8080');
  });

  it('${VAR:-default} prefers the env value when set', () => {
    const raw = validRawConfig();
    (raw['merchant'] as Record<string, unknown>)['publicBaseUrl'] =
      '${GATEWAY_PUBLIC_BASE_URL:-http://localhost:8080}';
    const config = parseConfig(raw, { GATEWAY_PUBLIC_BASE_URL: 'http://from-env.test' });
    expect(config.merchant.publicBaseUrl).toBe('http://from-env.test');
  });

  it('never prints the resolved value of a secret in an error message for an unrelated failure', () => {
    const raw = validRawConfig();
    const secret = 'super-secret-facilitator-key-0xDEADBEEF';
    (raw['payments'] as { x402: Record<string, unknown> }).x402['signerPrivateKey'] = undefined;
    (raw['payments'] as { x402: { facilitator: Record<string, unknown> } }).x402.facilitator = {
      mode: 'local',
      signerPrivateKey: secret,
    };
    // Trigger an unrelated failure (bad payTo) while a secret is present elsewhere in config.
    (raw['payments'] as { x402: Record<string, unknown> }).x402['payTo'] = 'not-an-address';

    try {
      parseConfig(raw, {});
      expect.unreachable();
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error.details)).not.toContain(secret);
      }
    }
  });
});

describe('protocols.mcp.mountPath', () => {
  function withMountPath(mountPath: unknown): Record<string, unknown> {
    const raw = validRawConfig();
    (raw['protocols'] as { mcp: Record<string, unknown> }).mcp['mountPath'] = mountPath;
    return raw;
  }

  // A bad mount only fails inside Fastify's route registration, deferred to
  // server.ready(), which takes the whole gateway down with an opaque FST_ERR_*
  // instead of degrading the one adapter. These must be CONFIG_INVALID at load.
  it.each([
    ['no leading slash', 'mcp'],
    ['a Fastify parameter', '/mcp/:id'],
    ['a Fastify wildcard', '/mcp/*'],
    ['a query marker', '/mcp?x=1'],
    ['whitespace', '/mcp path'],
    ['a trailing newline', '/mcp\n'],
    ['a route the gateway serves', '/health'],
    ['another route the gateway serves', '/api/receipts'],
    ['a prefix of a gateway route', '/api'],
    ['the root path, which is a prefix of everything', '/'],
  ])('rejects %s', (_label, mountPath) => {
    expectConfigInvalid(() => parseConfig(withMountPath(mountPath), {}));
  });

  it('names the offending field in the error', () => {
    try {
      parseConfig(withMountPath('/health'), {});
      expect.unreachable();
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('mountPath');
      }
    }
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
  function withA2a(a2a: unknown): Record<string, unknown> {
    const raw = validRawConfig();
    if (a2a === undefined) delete (raw['protocols'] as Record<string, unknown>)['a2a'];
    else (raw['protocols'] as Record<string, unknown>)['a2a'] = a2a;
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
    ['no leading slash', 'a2a'],
    ['a Fastify parameter', '/a2a/:id'],
    ['whitespace', '/a2a path'],
    ['a route the gateway serves', '/health'],
  ])('rejects a malformed mount: %s', (_label, mountPath) => {
    expectConfigInvalid(() => parseConfig(withA2a({ enabled: true, mountPath }), {}));
  });

  // The card path is fixed by the A2A spec and served by the adapter itself.
  it.each([
    ['the agent card path itself', '/.well-known/agent-card.json'],
    ['a prefix of it', '/.well-known'],
  ])('rejects %s as a configurable mount', (_label, mountPath) => {
    expectConfigInvalid(() => parseConfig(withA2a({ enabled: true, mountPath }), {}));
    const raw = validRawConfig();
    (raw['protocols'] as { mcp: Record<string, unknown> }).mcp['mountPath'] = mountPath;
    expectConfigInvalid(() => parseConfig(raw, {}));
  });

  it('rejects an unknown key inside the block', () => {
    expectConfigInvalid(() => parseConfig(withA2a({ enabled: true, streaming: true }), {}));
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

  it('rejects expose: [a2a] when protocols.a2a.enabled is false', () => {
    const raw = withA2a({ enabled: false });
    (raw['resources'] as { weather_basic: { expose: string[] } }).weather_basic.expose = ['a2a'];
    expectConfigInvalid(() => parseConfig(raw, {}));
    try {
      parseConfig(raw, {});
    } catch (error) {
      if (isCommerceError(error)) expect(error.message).toContain('a2a');
    }
  });

  // Each mount registers a `${mountPath}/*` wildcard, so an overlap means one
  // adapter answers for the other.
  it.each([
    ['an identical mount', '/mcp'],
    ['a mount nested under the mcp one', '/mcp/a2a'],
    ['a mount the mcp one nests under', '/'],
  ])('rejects %s while mcp is enabled', (_label, mountPath) => {
    expectConfigInvalid(() => parseConfig(withA2a({ enabled: true, mountPath }), {}));
  });

  it('allows a colliding mount while a2a is disabled, since nothing is mounted', () => {
    const config = parseConfig(withA2a({ enabled: false, mountPath: '/mcp' }), {});
    expect(config.protocols.a2a.enabled).toBe(false);
  });
});
