import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { compileJsonSchema, isFullyEnforced } from '../../../../src/core/execution/validation';

describe('compileJsonSchema', () => {
  it('accepts anything when no schema is given', () => {
    const validate = compileJsonSchema(undefined);
    expect(validate({ anything: true }).valid).toBe(true);
    expect(validate(42).valid).toBe(true);
    expect(validate(null).valid).toBe(true);
  });

  it('validates required properties on an object schema', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });

    expect(validate({ city: 'Berlin' })).toEqual({ valid: true, value: { city: 'Berlin' } });

    const missing = validate({});
    expect(missing.valid).toBe(false);
    if (!missing.valid) {
      expect(missing.errors).toEqual([{ path: '$.city', message: 'is required' }]);
    }
  });

  it('rejects the wrong top-level type', () => {
    const validate = compileJsonSchema({ type: 'object' });
    const result = validate('not-an-object');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]?.message).toContain('expected type "object"');
    }
  });

  it('rejects an array where an object schema is declared, so it cannot bypass `required`', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
    expect(validate([]).valid).toBe(false);
  });

  it('rejects additional properties when additionalProperties is false', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });

    const result = validate({ extra: 'nope' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual([
        { path: '$.extra', message: 'additional property not allowed' },
      ]);
    }
  });

  it('allows additional properties by default (additionalProperties omitted)', () => {
    const validate = compileJsonSchema({ type: 'object', properties: {} });
    expect(validate({ extra: 'ok' }).valid).toBe(true);
  });

  it('validates nested object properties recursively', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: { zip: { type: 'string' } },
          required: ['zip'],
        },
      },
    });

    const result = validate({ address: {} });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual([{ path: '$.address.zip', message: 'is required' }]);
    }
  });

  it('validates array items against a single items schema', () => {
    const validate = compileJsonSchema({
      type: 'array',
      items: { type: 'number' },
    });

    expect(validate([1, 2, 3]).valid).toBe(true);
    const result = validate([1, 'two', 3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual([
        { path: '$[1]', message: 'expected type "number" but got string' },
      ]);
    }
  });

  it('enforces enum membership', () => {
    const validate = compileJsonSchema({ type: 'string', enum: ['a', 'b'] });
    expect(validate('a').valid).toBe(true);
    expect(validate('c').valid).toBe(false);
  });

  it('ignores unsupported keywords such as pattern and minLength rather than crashing', () => {
    const validate = compileJsonSchema({
      type: 'string',
      minLength: 100,
      pattern: '^impossible$$$',
    });
    // Would fail if minLength/pattern were enforced; must pass since these are
    // documented as unsupported and therefore not checked
    expect(validate('short').valid).toBe(true);
  });

  it('validates integer vs number distinction', () => {
    const intValidate = compileJsonSchema({ type: 'integer' });
    expect(intValidate(4).valid).toBe(true);
    expect(intValidate(4.5).valid).toBe(false);
  });

  it('validates boolean and null types', () => {
    const boolValidate = compileJsonSchema({ type: 'boolean' });
    expect(boolValidate(true).valid).toBe(true);
    expect(boolValidate('true').valid).toBe(false);

    const nullValidate = compileJsonSchema({ type: 'null' });
    expect(nullValidate(null).valid).toBe(true);
    expect(nullValidate(0).valid).toBe(false);
  });

  it('reports array and null in error messages via describeType', () => {
    const validate = compileJsonSchema({ type: 'string' });
    const arrayResult = validate([1, 2]);
    expect(arrayResult.valid).toBe(false);
    if (!arrayResult.valid) expect(arrayResult.errors[0]?.message).toContain('array');

    const nullResult = validate(null);
    expect(nullResult.valid).toBe(false);
    if (!nullResult.valid) expect(nullResult.errors[0]?.message).toContain('null');
  });

  it('applies a schema to additional properties when additionalProperties is an object', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { known: { type: 'string' } },
      additionalProperties: { type: 'number' },
    });

    expect(validate({ known: 'ok', extra: 42 }).valid).toBe(true);
    const result = validate({ known: 'ok', extra: 'not-a-number' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual([
        { path: '$.extra', message: 'expected type "number" but got string' },
      ]);
    }
  });

  it('ignores an unrecognized type keyword rather than rejecting everything', () => {
    const validate = compileJsonSchema({ type: 'unsupported-future-type' });
    expect(validate('anything').valid).toBe(true);
  });

  it('deep-compares object enum values by structural equality', () => {
    const validate = compileJsonSchema({ enum: [{ a: 1 }, { b: 2 }] });
    expect(validate({ a: 1 }).valid).toBe(true);
    expect(validate({ a: 1, extra: true }).valid).toBe(false);
  });

  it('matches an object enum value whatever the key order', () => {
    const validate = compileJsonSchema({ enum: [{ a: 1, b: [2, { c: 3, d: 4 }] }, 0] });
    expect(validate({ b: [2, { d: 4, c: 3 }], a: 1 }).valid).toBe(true);
    expect(validate({ b: [{ d: 4, c: 3 }, 2], a: 1 }).valid).toBe(false);
    expect(validate(-0).valid).toBe(true);
  });

  it('short-circuits nested validation on a type mismatch', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { count: { type: 'integer' } },
    });
    // Wrong top-level type: nested property checks never run, only the
    // top-level type error is reported
    const result = validate('not-an-object');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toHaveLength(1);
  });

  it('enforces "required" for prototype-named field names, not just additionalProperties ', () => {
    const prototypeKeys = [
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
    ];
    for (const key of prototypeKeys) {
      const validate = compileJsonSchema({
        type: 'object',
        properties: { city: { type: 'string' }, [key]: { type: 'string' } },
        required: ['city', key],
      });
      // `key in {}` is true for every one of these (inherited), so a naive
      // `!(key in value)` required-check would never fire even though the
      // caller never supplied the field
      const result = validate({ city: 'Berlin' });
      expect(result.valid, `expected "${key}" to be reported as missing`).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual({ path: `$.${key}`, message: 'is required' });
      }
      // Control: supplying it as an own property satisfies the requirement
      const supplied = JSON.parse(`{"city":"Berlin","${key}":"present"}`);
      expect(validate(supplied).valid).toBe(true);
    }
  });

  it('rejects prototype-named keys under additionalProperties: false', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: { city: { type: 'string' } },
      additionalProperties: false,
    });

    const prototypeKeys = [
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
    ];
    for (const key of prototypeKeys) {
      const input = JSON.parse(`{"city":"paris","${key}":{"isAdmin":true}}`);
      const result = validate(input);
      expect(result.valid, `expected "${key}" to be rejected`).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual({
          path: `$.${key}`,
          message: 'additional property not allowed',
        });
      }
    }

    // Control: an unknown key is still rejected the same way
    const control = validate({ city: 'paris', evil: true });
    expect(control.valid).toBe(false);
  });

  it('does not use an inherited (non-own) property schema for a prototype-named key', () => {
    const validate = compileJsonSchema({
      type: 'object',
      properties: {},
      additionalProperties: { type: 'string' },
    });
    // properties['toString'] would resolve to Object.prototype.toString (a
    // function) via plain lookup; own-property lookup must not treat that as
    // "this key has a declared schema" and must fall through to
    // additionalProperties instead
    const result = validate(JSON.parse('{"toString":123}'));
    expect(result.valid).toBe(false);
  });

  it('enforces required + additionalProperties on a schema with `properties`/`required` but NO `type`', () => {
    const validate = compileJsonSchema({
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });

    const extraAndWrongType = validate({ EVIL: 'x', city: 123 });
    expect(extraAndWrongType.valid).toBe(false);

    const missingRequired = validate({});
    expect(missingRequired.valid).toBe(false);

    expect(validate({ city: 'Berlin' })).toEqual({ valid: true, value: { city: 'Berlin' } });
  });

  it('enforces an object schema declared with a `type` array, e.g. ["object","null"]', () => {
    const validate = compileJsonSchema({
      type: ['object', 'null'],
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });

    expect(validate(null).valid).toBe(true);
    expect(validate({ city: 'Berlin' }).valid).toBe(true);
    expect(validate({}).valid).toBe(false); // required still enforced
    expect(validate({ city: 'Berlin', evil: true }).valid).toBe(false); // still closed
  });
});

describe('isFullyEnforced', () => {
  const ENFORCED: readonly [string, Record<string, unknown>][] = [
    ['an empty schema', {}],
    [
      'a closed object with every supported keyword and the annotations',
      {
        type: 'object',
        title: 'Query',
        description: 'A query',
        $comment: 'internal',
        properties: {
          city: { type: 'string', examples: ['Oslo'], deprecated: false },
          days: { type: ['integer', 'null'], default: 3, readOnly: true },
          units: { enum: ['metric', 'imperial'], writeOnly: false },
          tags: { type: 'array', items: { type: 'string' } },
          extra: { type: 'object', additionalProperties: { type: 'number' } },
        },
        required: ['city'],
        additionalProperties: false,
      },
    ],
    [
      'properties without a type',
      { properties: { a: { type: 'boolean' } }, additionalProperties: false },
    ],
  ];

  it.each(ENFORCED)('is true for %s', (_label, schema) => {
    expect(isFullyEnforced(schema)).toBe(true);
  });

  it.each([
    ['a non-object schema', true],
    ['an unenforced keyword', { type: 'string', minLength: 1 }],
    ['a keyword the config warning list lacks', { type: 'object', minProperties: 1 }],
    [
      'an unenforced keyword in a property',
      { properties: { a: { type: 'string', format: 'email' } } },
    ],
    [
      'an unenforced keyword in additionalProperties',
      { type: 'object', additionalProperties: { const: 1 } },
    ],
    ['an unenforced keyword in items', { type: 'array', items: { type: 'string', pattern: 'x' } }],
    ['a boolean property schema', { properties: { a: true } }],
    ['a tuple items', { type: 'array', items: [{ type: 'string' }] }],
    ['items without an array type', { items: { type: 'string' } }],
    ['additionalProperties without an object node', { additionalProperties: false }],
    ['an unknown type', { type: 'date' }],
    ['an empty type list', { type: [] }],
    ['a non-string type', { type: [1] }],
    ['a non-array enum', { enum: 'a' }],
    ['non-string required entries', { type: 'object', required: [1] }],
    ['a non-object properties', { properties: [] }],
    ['$ref', { $ref: '#/$defs/a' }],
    ['$schema', { $schema: 'https://json-schema.org/draft/2020-12/schema' }],
  ])('is false for %s', (_label, schema) => {
    expect(isFullyEnforced(schema)).toBe(false);
  });

  // Compare gateway and Ajv 2020-12 verdicts for these schemas and sample values
  const ajv = new Ajv2020({ strict: false });
  const VALUES: readonly unknown[] = [
    {},
    { city: 'Oslo' },
    { city: 'Oslo', days: null, units: 'metric', tags: ['a'], extra: { n: 1 } },
    { city: 'Oslo', units: 'kelvin' },
    { city: 1 },
    { city: 'Oslo', tags: [1] },
    { city: 'Oslo', extra: { n: 'x' } },
    { city: 'Oslo', unknown: true },
    { a: true },
    { a: 'yes' },
    [],
    'text',
    null,
  ];

  it.each(ENFORCED)('agrees with Ajv 2020-12 on every sample value for %s', (_label, schema) => {
    const gateway = compileJsonSchema(schema);
    const reference = ajv.compile(schema);
    expect(VALUES.map((value) => gateway(value).valid)).toEqual(
      VALUES.map((value) => reference(value)),
    );
  });
});
