/**
 * A small JSON Schema validator for resource input.
 *
 * Supported subset (draft 2020-12 vocabulary, structural only):
 * - `type`: "object" | "string" | "number" | "integer" | "boolean" | "array" |
 *   "null", or an array of those (e.g. `["object", "null"]`)
 * - `properties` (validated recursively)
 * - `required` (string[])
 * - `additionalProperties` (boolean, or a schema applied to extra properties)
 * - `enum` (allowed values; objects and arrays compared structurally, in any key
 *   order)
 * - `items` (one schema applied to every array element, no tuple form)
 *
 * Not enforced: every other constraint, among them `minLength`, `maxLength`,
 * `pattern`, `format`, `minimum`, `maximum`, `multipleOf`, `oneOf`, `anyOf`,
 * `allOf`, `not`, `$ref`, `const`, `patternProperties`, `minItems`, `maxItems`
 * and `uniqueItems`, tuple-form `items`, and a `type` naming anything outside
 * the list above. Config warns at load when a schema uses a keyword outside
 * `ENFORCED_SCHEMA_KEYWORDS` or a tuple `items`.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonSchema } from '../domain/common';
import { isRecord } from '../is-record';

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly valid: true; readonly value: unknown }
  | { readonly valid: false; readonly errors: readonly FieldError[] };

export type Validator = (input: unknown) => ValidationResult;

const SUPPORTED_TYPES = new Set([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'null',
]);

/**
 * Keywords enforced by `validateNode`, plus annotations that do not constrain
 * input. Includes the singular OpenAPI `example` carried by `import openapi`.
 * Config warns about input schema keywords outside this set.
 */
export const ENFORCED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'items',
  'title',
  'description',
  'example',
  'examples',
  'default',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

// The value forms JSON Schema 2020-12 allows for the annotations above
const ANNOTATION_FORMS: readonly (readonly [string, string, (value: unknown) => boolean])[] = [
  ['title', 'a string', (value) => typeof value === 'string'],
  ['description', 'a string', (value) => typeof value === 'string'],
  ['$comment', 'a string', (value) => typeof value === 'string'],
  ['examples', 'a list', Array.isArray],
  ['deprecated', 'a boolean', (value) => typeof value === 'boolean'],
  ['readOnly', 'a boolean', (value) => typeof value === 'boolean'],
  ['writeOnly', 'a boolean', (value) => typeof value === 'boolean'],
];

const isDistinctStrings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'string') &&
  new Set(value).size === value.length;

/**
 * Find the first unsupported or malformed part of a schema: a keyword outside
 * `ENFORCED_SCHEMA_KEYWORDS`, a subschema that is not an object, `items` or
 * `additionalProperties` that this validator would not apply under the node's
 * type, or an invalid keyword value. Check keyword forms against JSON Schema
 * 2020-12 and reject empty `enum` arrays, which Ajv also refuses to compile.
 * Return `undefined` when these checks pass.
 */
export function unenforcedSchemaPart(schema: unknown, path = '$'): FieldError | undefined {
  if (!isRecord(schema)) return { path, message: 'is not a schema object' };
  const unknown = Object.keys(schema).find((key) => !ENFORCED_SCHEMA_KEYWORDS.has(key));
  if (unknown !== undefined) {
    return { path, message: `uses "${unknown}", which the gateway does not enforce` };
  }
  const malformed = (keyword: string, form: string): FieldError => ({
    path,
    message: `has a "${keyword}" that is not ${form}`,
  });
  const { type, properties, required, additionalProperties, items } = schema;
  const types = typeof type === 'string' ? [type] : type === undefined ? [] : type;
  if (
    !isDistinctStrings(types) ||
    (Array.isArray(type) && type.length === 0) ||
    !types.every((entry) => SUPPORTED_TYPES.has(entry))
  ) {
    return malformed('type', 'a supported type or a list of distinct ones');
  }
  if (required !== undefined && !isDistinctStrings(required)) {
    return malformed('required', 'a list of distinct strings');
  }
  const allowed = schema['enum'];
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.length === 0)) {
    return malformed('enum', 'a list with at least one value');
  }
  for (const [keyword, form, accepts] of ANNOTATION_FORMS) {
    if (schema[keyword] !== undefined && !accepts(schema[keyword])) return malformed(keyword, form);
  }
  if (properties !== undefined) {
    if (!isRecord(properties)) return malformed('properties', 'an object');
    for (const [key, sub] of Object.entries(properties)) {
      const part = unenforcedSchemaPart(sub, `${path}.properties.${key}`);
      if (part !== undefined) return part;
    }
  }
  // `validateNode` applies these two only when the node's type admits them
  if (additionalProperties !== undefined) {
    if (!isObjectSchemaNode(schema)) {
      return { path, message: 'declares "additionalProperties" but is not an object schema' };
    }
    if (typeof additionalProperties !== 'boolean') {
      const part = unenforcedSchemaPart(additionalProperties, `${path}.additionalProperties`);
      if (part !== undefined) return part;
    }
  }
  if (items === undefined) return undefined;
  if (!types.includes('array')) {
    return { path, message: 'declares "items" but its type does not include "array"' };
  }
  // A tuple `items` (an array of schemas) is not enforced
  return unenforcedSchemaPart(items, `${path}.items`);
}

/** Wrap a resource `inputSchema` in a reusable validator function */
export function compileJsonSchema(schema: JsonSchema | undefined): Validator {
  return (input: unknown): ValidationResult => {
    if (schema === undefined) return { valid: true, value: input };
    const errors = validateNode(schema, input, '$');
    return errors.length === 0 ? { valid: true, value: input } : { valid: false, errors };
  };
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// `===` first keeps a top-level -0 equal to 0; isDeepStrictEqual alone would not
function deepEqual(a: unknown, b: unknown): boolean {
  return a === b || isDeepStrictEqual(a, b);
}

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// `type` may be a string or an array of strings, e.g. `["object", "null"]`. An
// array with a non-string entry is ignored rather than guessed at.
function typeList(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.every((entry): entry is string => typeof entry === 'string')) {
    return raw;
  }
  return undefined;
}

/**
 * Whether a schema node is an object schema: its `type` includes "object"
 * (`["object", "null"]` counts), or it has no `type` and declares `properties`
 * or `required`.
 *
 * Config's `defaultClosedObjectSchema` uses it to close schemas and this
 * validator uses it to enforce them. With two definitions, a node could stay
 * open while config believes it closed.
 */
export function isObjectSchemaNode(schema: Record<string, unknown>): boolean {
  const types = typeList(schema['type']);
  if (types !== undefined) return types.includes('object');
  return Object.hasOwn(schema, 'properties') || Object.hasOwn(schema, 'required');
}

function validateNode(schema: JsonSchema, value: unknown, path: string): FieldError[] {
  const errors: FieldError[] = [];
  const types = typeList(own(schema, 'type'));
  const recognizedTypes = types?.filter((entry) => SUPPORTED_TYPES.has(entry));

  if (
    types !== undefined &&
    recognizedTypes !== undefined &&
    recognizedTypes.length === types.length &&
    types.length > 0
  ) {
    if (!types.some((entry) => matchesType(entry, value))) {
      errors.push({
        path,
        message: `expected type "${types.join(' | ')}" but got ${describeType(value)}`,
      });
      return errors;
    }
  }

  const enumRaw = own(schema, 'enum');
  if (Array.isArray(enumRaw)) {
    const allowed = enumRaw as unknown[];
    if (!allowed.some((candidate) => deepEqual(candidate, value))) {
      errors.push({ path, message: `must be one of ${JSON.stringify(allowed)}` });
    }
  }

  if (isObjectSchemaNode(schema) && isRecord(value)) {
    errors.push(...validateObject(schema, value, path));
  } else if ((types?.includes('array') ?? false) && Array.isArray(value)) {
    errors.push(...validateArray(schema, value, path));
  }

  return errors;
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
): FieldError[] {
  const errors: FieldError[] = [];
  const propsRaw = own(schema, 'properties');
  const properties = isRecord(propsRaw) ? propsRaw : {};
  const requiredRaw = own(schema, 'required');
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((entry): entry is string => typeof entry === 'string')
    : [];

  for (const key of required) {
    // Object.hasOwn, not `in`: `in` walks the prototype chain, so a required
    // "toString" or "__proto__" would always look present
    if (!Object.hasOwn(value, key)) {
      errors.push({ path: `${path}.${key}`, message: 'is required' });
    }
  }

  const additional = own(schema, 'additionalProperties');

  for (const key of Object.keys(value)) {
    // Own-property lookup: `properties["toString"]` would find the inherited
    // member and skip the additionalProperties check below
    const propSchemaRaw = own(properties, key);
    if (propSchemaRaw !== undefined) {
      if (isRecord(propSchemaRaw)) {
        errors.push(...validateNode(propSchemaRaw, value[key], `${path}.${key}`));
      }
      continue;
    }
    if (additional === false) {
      errors.push({ path: `${path}.${key}`, message: 'additional property not allowed' });
    } else if (isRecord(additional)) {
      errors.push(...validateNode(additional, value[key], `${path}.${key}`));
    }
  }

  return errors;
}

function validateArray(schema: JsonSchema, value: unknown[], path: string): FieldError[] {
  const errors: FieldError[] = [];
  const itemsRaw = own(schema, 'items');
  if (isRecord(itemsRaw)) {
    value.forEach((item, index) => {
      errors.push(...validateNode(itemsRaw, item, `${path}[${index}]`));
    });
  }
  return errors;
}
