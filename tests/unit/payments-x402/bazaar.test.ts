// HTTP and MCP Bazaar metadata forms, upstream validation and omission rules
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  extractDiscoveryInfo,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from '@x402/extensions/bazaar';
import { describe, expect, it } from 'vitest';
import type { CommerceResource, JsonSchema } from '../../../src/core';
import {
  type BazaarExtension,
  type BazaarSurface,
  bazaarMetadata,
} from '../../../src/payments/x402/provider/bazaar';
import { buildInputSchema } from '../../../src/protocols/mcp/tool-mapping';

const INPUT: JsonSchema = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'City name' },
    days: { type: 'integer', default: 3 },
    units: { type: 'string', enum: ['metric', 'imperial'] },
    filters: {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
      additionalProperties: false,
    },
    verbose: { type: 'boolean' },
  },
  required: ['city', 'days', 'units', 'filters'],
  additionalProperties: false,
};
const EXAMPLE = { city: '<city>', days: 3, units: 'metric', filters: { tags: ['<tags>'] } };

function resource(overrides: Partial<CommerceResource> = {}): CommerceResource {
  return {
    id: 'weather',
    name: 'Weather',
    description: 'Forecast for a city',
    inputSchema: INPUT,
    handler: { type: 'http', method: 'POST', url: 'http://backend.local/forecast' },
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    exposedVia: ['http', 'mcp'],
    paymentMethods: ['x402'],
    ...overrides,
  };
}

const BOTH: readonly BazaarSurface[] = ['http', 'mcp'];

function extensionOf(surface: BazaarSurface, of = resource()): BazaarExtension {
  const extension = bazaarMetadata(of, [surface]).extensions[surface];
  if (extension === undefined) return expect.unreachable(`no ${surface} extension`);
  return extension;
}

// A forwarded payload, as a facilitator receives it with the metadata
function forwarded(url: string, extension: BazaarExtension): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url, description: 'Forecast for a city', mimeType: 'application/json' },
    accepted: {} as PaymentRequirements,
    payload: {},
    extensions: { bazaar: extension },
  };
}

describe('Bazaar metadata forms', () => {
  it('describes the invoke route as a POST of the example JSON body', () => {
    expect(extensionOf('http').info).toEqual({
      input: { type: 'http', method: 'POST', bodyType: 'json', body: EXAMPLE },
    });
  });

  it('describes the MCP tool by its id, schema and example', () => {
    expect(extensionOf('mcp').info).toEqual({
      input: {
        type: 'mcp',
        toolName: 'weather',
        description: 'Forecast for a city',
        inputSchema: INPUT,
        example: EXAMPLE,
      },
    });
  });

  it.each(BOTH)('passes upstream validation of the %s form', (surface) => {
    const extension = extensionOf(surface);
    expect(validateDiscoveryExtension(extension as never)).toEqual({ valid: true });
    expect(validateDiscoveryExtensionSpec(extension as never)).toEqual({ valid: true });
  });

  it('is extracted by upstream as an HTTP listing keyed by the invoke URL', () => {
    const url = 'https://shop.example/api/resources/weather/invoke';
    const extension = extensionOf('http');
    expect(extractDiscoveryInfo(forwarded(url, extension), {} as PaymentRequirements)).toEqual({
      resourceUrl: url,
      description: 'Forecast for a city',
      mimeType: 'application/json',
      x402Version: 2,
      discoveryInfo: extension.info,
      extensions: { bazaar: extension },
      routeTemplate: undefined,
      method: 'POST',
    });
  });

  it('is extracted by upstream as an MCP listing keyed by the mount URL and tool name', () => {
    const url = 'https://shop.example/mcp';
    const extension = extensionOf('mcp');
    expect(
      extractDiscoveryInfo(forwarded(url, extension), {} as PaymentRequirements),
    ).toMatchObject({ resourceUrl: url, toolName: 'weather', discoveryInfo: extension.info });
  });

  it('declares the same MCP input schema as tools/list, less the reserved fields', () => {
    // No `type`: tools/list adds `type: 'object'`, which the declared schema must match
    const { type: _, ...untyped } = INPUT;
    const paid = resource({ inputSchema: untyped, authorization: { required: ['ap2'] } });
    const listed = buildInputSchema(paid) as { properties: Record<string, unknown> };
    // Confirm that MCP added both reserved carrier fields
    expect(Object.keys(listed.properties)).toEqual(
      expect.arrayContaining(['_payment', '_authorization']),
    );
    const { _payment, _authorization, ...properties } = listed.properties;

    expect(extensionOf('mcp', paid).info['input']).toMatchObject({
      inputSchema: { ...listed, properties },
    });
  });

  it('keeps the backend URL, its headers and the reserved fields out of the metadata', () => {
    const secret = resource({
      handler: {
        type: 'http',
        method: 'POST',
        url: 'https://internal.backend.example/secret-path/forecast',
        headers: { 'x-api-key': 'sk_live_backend_credential' },
      },
      authorization: { required: ['ap2'] },
    });
    const text = JSON.stringify(bazaarMetadata(secret, BOTH).extensions);
    for (const leaked of [
      'internal.backend',
      'secret-path',
      'x-api-key',
      'sk_live',
      '_payment',
      '_authorization',
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it('adds an output example the output schema provably accepts', () => {
    const outputSchema = {
      type: 'object',
      properties: { forecast: { type: 'string' } },
      required: ['forecast'],
    };
    const extension = extensionOf('http', resource({ outputSchema }));
    expect(extension.info['output']).toEqual({ type: 'json', example: { forecast: '<forecast>' } });
    expect(validateDiscoveryExtension(extension as never)).toEqual({ valid: true });
  });

  it.each([
    [
      'uses a keyword the gateway does not enforce',
      { type: 'object', properties: { at: { type: 'string', format: 'date' } } },
    ],
    ['rejects its own generated example', { type: 'string', enum: [1] }],
    ['gives a keyword a malformed value', { type: 'object', required: ['a', 'a'] }],
  ])('declares no output when the output schema %s', (_label, outputSchema) => {
    const extension = extensionOf('http', resource({ outputSchema }));
    expect(extension.info).not.toHaveProperty('output');
    expect(extension.schema['properties']).not.toHaveProperty('output');
    expect(validateDiscoveryExtension(extension as never)).toEqual({ valid: true });
  });

  const OUTPUT = {
    type: 'object',
    properties: { forecast: { type: 'string' } },
    required: ['forecast'],
  };
  const httpWith = (mimeType: string) =>
    bazaarMetadata(resource({ outputSchema: OUTPUT }), ['http'], mimeType).extensions.http;

  it.each(['text/html', 'text/plain; charset=utf-8', 'application/xml', 'application/jsonl'])(
    'declares no JSON output for a resource whose media type is %s',
    (mimeType) => {
      const extension = httpWith(mimeType);
      expect(extension?.info).toEqual({
        input: { type: 'http', method: 'POST', bodyType: 'json', body: EXAMPLE },
      });
      expect(validateDiscoveryExtension(extension as never)).toEqual({ valid: true });
    },
  );

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/problem+json',
    'Application/JSON',
  ])('declares the JSON output example for a resource whose media type is %s', (mimeType) => {
    expect(httpWith(mimeType)?.info['output']).toEqual({
      type: 'json',
      example: { forecast: '<forecast>' },
    });
  });

  it('describes a resource without an input schema as taking an empty object', () => {
    const { inputSchema: _, ...open } = resource();
    expect(extensionOf('http', open).info['input']).toEqual({
      type: 'http',
      method: 'POST',
      bodyType: 'json',
      body: {},
    });
    expect(extensionOf('mcp', open).info['input']).toMatchObject({
      inputSchema: { type: 'object', properties: {} },
      example: {},
    });
  });

  it('builds nothing for no surface', () => {
    expect(bazaarMetadata(resource(), [])).toEqual({ extensions: {}, omitted: [] });
  });
});

describe('Bazaar metadata omission', () => {
  const nested = (property: Record<string, unknown>) =>
    resource({
      inputSchema: {
        type: 'object',
        properties: { city: property },
        required: ['city'],
        additionalProperties: false,
      },
    });

  const NOT_ENFORCED = 'which the gateway does not enforce';
  const BAD_TYPE = 'has a "type" that is not a supported type or a list of distinct ones';

  it.each([
    [
      'pattern',
      nested({ type: 'string', pattern: '^[A-Z]' }),
      `input.properties.city uses "pattern", ${NOT_ENFORCED}`,
    ],
    [
      'a nested format',
      nested({ type: 'object', properties: { d: { type: 'string', format: 'date' } } }),
      `input.properties.city.properties.d uses "format", ${NOT_ENFORCED}`,
    ],
    [
      '$ref',
      nested({ $ref: '#/$defs/city' }),
      `input.properties.city uses "$ref", ${NOT_ENFORCED}`,
    ],
    [
      'minProperties',
      resource({ inputSchema: { type: 'object', minProperties: 1 } }),
      `input uses "minProperties", ${NOT_ENFORCED}`,
    ],
    [
      'a tuple items',
      nested({ type: 'array', items: [{ type: 'string' }] }),
      'input.properties.city.items is not a schema object',
    ],
    [
      'additionalProperties without an object type',
      nested({ additionalProperties: false }),
      'input.properties.city declares "additionalProperties" but is not an object schema',
    ],
    [
      'items without an array type',
      nested({ items: { type: 'string' } }),
      'input.properties.city declares "items" but its type does not include "array"',
    ],
    ['an empty type list', nested({ type: [] }), `input.properties.city ${BAD_TYPE}`],
    ['an unknown type', nested({ type: 'date' }), `input.properties.city ${BAD_TYPE}`],
  ])('leaves out a resource whose input schema uses %s, naming the place', (_label, of, place) => {
    expect(bazaarMetadata(of, BOTH)).toEqual({
      extensions: {},
      omitted: [{ surfaces: BOTH, reason: `its input schema cannot be published as is: ${place}` }],
    });
  });

  // Gateway validation tolerates these malformed keyword values, but the
  // facilitator's schema compiler rejects them
  it.each([
    ['a repeated required name', { type: 'object', required: ['a', 'a'] }, 'required'],
    ['a repeated type', { type: ['string', 'string'] }, 'type'],
    ['examples that are not a list', { type: 'string', examples: 'x' }, 'examples'],
    ['a numeric description', { type: 'string', description: 5 }, 'description'],
    ['a numeric title', { type: 'string', title: 7 }, 'title'],
    ['a deprecated that is not a boolean', { type: 'string', deprecated: 'yes' }, 'deprecated'],
    ['an empty enum', { enum: [] }, 'enum'],
  ])(
    'leaves out a resource whose input schema has %s, which upstream validation refuses',
    (_label, property, keyword) => {
      // Replace a valid property schema in the published HTTP form with this one
      const published = extensionOf('http');
      const withProperty = structuredClone(published) as unknown as {
        schema: { properties: { input: { properties: { body: JsonSchema } } } };
      };
      withProperty.schema.properties.input.properties.body = nested(property)
        .inputSchema as JsonSchema;
      expect(validateDiscoveryExtension(withProperty as never).valid).toBe(false);

      const { extensions, omitted } = bazaarMetadata(nested(property), BOTH);
      expect(extensions).toEqual({});
      expect(omitted).toHaveLength(1);
      expect(omitted[0]?.reason).toContain(`input.properties.city has a "${keyword}"`);
    },
  );

  it.each([
    ['fails the input schema', nested({ type: 'string', enum: [1] })],
    [
      'fails the backend request shape',
      resource({
        inputSchema: {
          type: 'object',
          properties: { where: { type: 'string' } },
          required: ['where'],
        },
        handler: {
          type: 'http',
          method: 'GET',
          url: 'http://backend.local/{city}',
          inputBindings: { path: 'where' },
        },
      }),
    ],
  ])('leaves out a resource whose generated example %s', (_label, of) => {
    expect(bazaarMetadata(of, BOTH).omitted).toEqual([
      {
        surfaces: BOTH,
        reason: 'the example generated from its input schema fails the gateway input checks',
      },
    ]);
  });

  const TOO_LONG = [
    {
      surfaces: BOTH,
      reason: 'its description is longer than 500 characters, which the CDP facilitator refuses',
    },
  ];

  it('keeps a resource whose description is exactly 500 characters', () => {
    const { extensions, omitted } = bazaarMetadata(
      resource({ description: 'd'.repeat(500) }),
      BOTH,
    );
    expect(Object.keys(extensions)).toEqual(['http', 'mcp']);
    expect(omitted).toEqual([]);
  });

  it('leaves out a resource whose description is 501 characters', () => {
    expect(bazaarMetadata(resource({ description: 'd'.repeat(501) }), BOTH)).toEqual({
      extensions: {},
      omitted: TOO_LONG,
    });
  });

  it('applies the limit to the name when there is no description', () => {
    const { description: _, ...rest } = resource({ name: 'n'.repeat(501) });
    expect(bazaarMetadata(rest, BOTH)).toEqual({ extensions: {}, omitted: TOO_LONG });
  });

  it('leaves out each surface whose extension exceeds 4 KiB, and keeps the others', () => {
    // The MCP form also carries the description. With it at 480 characters
    // and 45 properties, MCP is over 4096 bytes and HTTP under.
    const properties = Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [`property_${i}`, { type: 'string' }]),
    );
    const of = resource({
      description: 'd'.repeat(480),
      inputSchema: { type: 'object', properties, required: Object.keys(properties) },
    });
    const { extensions, omitted } = bazaarMetadata(of, BOTH);

    expect(Object.keys(extensions)).toEqual(['http']);
    expect(Buffer.byteLength(JSON.stringify(extensions.http))).toBeGreaterThan(3800);
    expect(omitted).toEqual([{ surfaces: ['mcp'], reason: 'the extension exceeds 4096 bytes' }]);
  });
});
