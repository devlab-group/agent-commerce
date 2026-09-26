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
 * Not enforced: `minLength`, `maxLength`, `pattern`, `format`, `minimum`,
 * `maximum`, `exclusiveMinimum/Maximum`, `multipleOf`, `oneOf`, `anyOf`,
 * `allOf`, `not`, `$ref`, `const`, `patternProperties`, `minItems`,
 * `maxItems`, `uniqueItems`, tuple-form `items`, and a `type` naming anything
 * outside the list above. Config warns at load when a schema uses one of these
 * keywords or a tuple `items`.
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
