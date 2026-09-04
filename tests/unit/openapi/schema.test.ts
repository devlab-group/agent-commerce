import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertSchema, loadOpenApiDocument } from '../../../src/openapi/index.js';

const fixture = (name: string): string =>
  join(fileURLToPath(new URL('./fixtures/', import.meta.url)), name);

let document: Record<string, unknown>;

beforeAll(async () => {
  document = (await loadOpenApiDocument(fixture('schemas-3.0.yaml'))).document;
});

const convert = (name: string) => convertSchema(document, { $ref: `#/components/schemas/${name}` });

describe('convertSchema', () => {
  it('converts a primitive and keeps its metadata', () => {
    const result = convert('Primitive');
    expect(result).toMatchObject({
      supported: true,
      schema: { type: 'string', description: 'A name', default: 'anon' },
    });
  });

  it('turns OpenAPI 3.0 nullable into a union type the validator understands', () => {
    const result = convert('NullableString');
    expect(result.supported && result.schema['type']).toEqual(['string', 'null']);
  });

  it('keeps a 3.1 union type as written', () => {
    const result = convertSchema(document, { type: ['string', 'null'] });
    expect(result.supported && result.schema['type']).toEqual(['string', 'null']);
  });

  it('keeps enum values', () => {
    const result = convert('Enum');
    expect(result.supported && result.schema['enum']).toEqual(['draft', 'sent', 'paid']);
  });

  it('drops constraints the gateway does not enforce and names them', () => {
    const result = convert('Constrained');
    expect(result.supported && [...result.dropped].sort()).toEqual([
      'format',
      'minimum',
      'pattern',
    ]);
    const properties = result.supported
      ? (result.schema['properties'] as Record<string, Record<string, unknown>>)
      : {};
    expect(properties['email']).toEqual({ type: 'string' });
    expect(result.supported && result.schema['required']).toEqual(['email']);
  });

  it('resolves nested internal $refs and arrays', () => {
    const result = convert('Nested');
    expect(result.supported && result.schema).toMatchObject({
      type: 'object',
      properties: {
        owner: { type: 'object', properties: { email: { type: 'string' } } },
        tags: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    });
  });

  it('closes an object schema that does not say otherwise', () => {
    const result = convert('Base');
    expect(result.supported && result.schema['additionalProperties']).toBe(false);
  });

  it('keeps an additionalProperties subschema', () => {
    const result = convert('OpenMap');
    expect(result.supported && result.schema['additionalProperties']).toEqual({ type: 'number' });
  });

  it('drops tuple-form items rather than implying they are checked', () => {
    // Tuple `items` is not legal OpenAPI 3.0, so it is converted directly
    // rather than through a fixture the loader would reject.
    const result = convertSchema(document, {
      type: 'array',
      items: [{ type: 'string' }, { type: 'integer' }],
    });
    expect(result.supported && result.schema['items']).toBeUndefined();
    expect(result.supported && result.dropped).toContain('items (tuple form)');
  });

  it('keeps required even when the schema declares no properties', () => {
    const result = convert('RequiredOnly');
    expect(result.supported && result.schema['required']).toEqual(['id']);
  });

  it('merges a simple allOf of compatible object schemas', () => {
    const result = convert('MergedAllOf');
    expect(result.supported && result.schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
      description: 'Merged',
    });
  });

  it('refuses an allOf whose branches disagree about a property', () => {
    const result = convert('ConflictingAllOf');
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('cannot be merged');
  });

  it('refuses oneOf/anyOf/not rather than widening what is accepted', () => {
    const result = convert('OneOf');
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('oneOf');
    expect(convertSchema(document, { anyOf: [{ type: 'string' }] }).supported).toBe(false);
    expect(convertSchema(document, { not: { type: 'string' } }).supported).toBe(false);
  });

  it('reports a reference cycle instead of expanding it', () => {
    const result = convert('Cyclic');
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('circular');
  });

  it('accepts the 3.1 boolean schema `true` and refuses `false`', () => {
    expect(convertSchema(document, true)).toMatchObject({ supported: true, schema: {} });
    expect(convertSchema(document, false).supported).toBe(false);
  });

  it('ignores annotations that are not constraints', () => {
    const result = convertSchema(document, {
      type: 'string',
      readOnly: true,
      xml: { name: 'a' },
      'x-vendor': 1,
    });
    expect(result.supported && result.dropped).toEqual([]);
  });
});
