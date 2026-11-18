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
      output: { type: 'json' },
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
  ])('leaves out the output example when the output schema %s', (_label, outputSchema) => {
    expect(extensionOf('http', resource({ outputSchema })).info['output']).toEqual({
      type: 'json',
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

  it.each([
    ['pattern', nested({ type: 'string', pattern: '^[A-Z]' })],
    [
      'a nested format',
      nested({ type: 'object', properties: { d: { type: 'string', format: 'date' } } }),
    ],
    ['$ref', nested({ $ref: '#/$defs/city' })],
    [
      'minProperties, which config does not warn about',
      resource({ inputSchema: { type: 'object', minProperties: 1 } }),
    ],
    ['a tuple items', nested({ type: 'array', items: [{ type: 'string' }] })],
    ['additionalProperties without an object type', nested({ additionalProperties: false })],
    ['items without an array type', nested({ items: { type: 'string' } })],
    ['an empty type list', nested({ type: [] })],
    ['an unknown type', nested({ type: 'date' })],
  ])('leaves out a resource whose input schema uses %s', (_label, of) => {
    expect(bazaarMetadata(of, BOTH)).toEqual({
      extensions: {},
      omitted: [
        {
          surfaces: BOTH,
          reason:
            'its input schema uses a keyword the gateway does not enforce, which leaves the example unproven',
        },
      ],
    });
  });

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
    // and 44 properties, MCP is over 4096 bytes and HTTP under.
    const properties = Object.fromEntries(
      Array.from({ length: 44 }, (_, i) => [`property_${i}`, { type: 'string' }]),
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
