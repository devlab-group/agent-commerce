/**
 * A small, honest JSON Schema validator for resource input.
 *
 * Supported subset (draft-2020-12 vocabulary, structural only):
 * - `type`: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null",
 * or an array of any of those (draft-2020-12 union form, e.g. `["object","null"]`)
 * - `properties` (object schemas, validated recursively)
 * - `required` (string[])
 * - `additionalProperties` (boolean, or a schema applied to extra properties)
 * - `enum` (array of allowed literal values, deep-equality compared)
 * - `items` (single schema applied to every array element — no tuple form)
 *
 * Explicitly NOT supported and silently ignored (never enforced):
 * `minLength`, `maxLength`, `pattern`, `format`, `minimum`, `maximum`,
 * `exclusiveMinimum/Maximum`, `multipleOf`, `oneOf`, `anyOf`, `allOf`, `not`,
 * `$ref`, `const`, `patternProperties`, `minItems`, `maxItems`, `uniqueItems`,
 * tuple-style `items` arrays. An unrecognised `type` value is not enforced
 * either. This is a deliberate, documented limitation for v0.1.0-alpha — do
 * not assume any of the above is validated.
 */
import type { JsonSchema } from '../domain/common.js';

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

/** Compile a resource `inputSchema` into a reusable validator function. */
export function compileJsonSchema(schema: JsonSchema | undefined): Validator {
  return (input: unknown): ValidationResult => {
    if (schema === undefined) return { valid: true, value: input };
    const errors = validateNode(schema, input, '$');
    return errors.length === 0 ? { valid: true, value: input } : { valid: false, errors };
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * `type` may be a single string or (draft-2020-12) an array of strings,
 * e.g. `["object", "null"]`. Only recognised when every entry is a string —
 * same conservative "skip rather than guess" rule the single-string form
 * already followed for an unrecognised type name.
 */
function typeList(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.every((entry): entry is string => typeof entry === 'string')) {
    return raw;
  }
  return undefined;
}

/**
 * A bare `type === 'object'` string comparison is not enough: `type:
 * ["object", "null"]` — valid JSON Schema — would never route into
 * `validateObject`, so neither `required` nor `additionalProperties` would be
 * enforced on it, while `defaultClosedObjectSchema` (src/config) stamps
 * `additionalProperties: false` on it believing it closed. Also treats a node
 * with `properties`/`required` and no `type`
 * at all as an object schema, the same shape config's own stamping already
 * recognises via a bare `properties` check — a schema author relying on
 * `type` being implied by `properties` should not be silently unenforced.
 *
 * **exported**, and now the only definition of "this node is
 * an object schema" in the codebase. `src/config`'s `defaultClosedObjectSchema`
 * carried its own — `declaresObjectType || properties` — one keyword short of
 * this one, so a schema declaring only `required` was stamped by neither:
 * config left it open and this validator then enforced nothing on it, quietly
 * forwarding every unknown caller key to the merchant's backend while
 * docs/security.md promised "closed by default at every level". These two
 * definitions have been aligned once already; keeping them as two definitions
 * is what let them drift again.
 */
export function isObjectSchemaNode(schema: Record<string, unknown>): boolean {
  const types = typeList(schema['type']);
  if (types !== undefined) return types.includes('object');
  return Object.hasOwn(schema, 'properties') || Object.hasOwn(schema, 'required');
}

function validateNode(schema: JsonSchema, value: unknown, path: string): FieldError[] {
  const errors: FieldError[] = [];
  const types = typeList(own(schema, 'type'));
  const recognisedTypes = types?.filter((entry) => SUPPORTED_TYPES.has(entry));

  if (
    types !== undefined &&
    recognisedTypes !== undefined &&
    recognisedTypes.length === types.length &&
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

  if (isObjectSchemaNode(schema) && isPlainObject(value)) {
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
  const properties = isPlainObject(propsRaw) ? propsRaw : {};
  const requiredRaw = own(schema, 'required');
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((entry): entry is string => typeof entry === 'string')
    : [];

  for (const key of required) {
    // Object.hasOwn, not `in`: `in` walks the prototype chain, so a schema
    // requiring "toString"/"constructor"/"valueOf"/"hasOwnProperty"/
    // "__proto__" could never actually enforce it — those names are always
    // present via inheritance, so `!(key in value)` is always false. This is
    // the same bug class every other lookup in this file already
    // guards against by using own().
    if (!Object.hasOwn(value, key)) {
      errors.push({ path: `${path}.${key}`, message: 'is required' });
    }
  }

  const additional = own(schema, 'additionalProperties');

  for (const key of Object.keys(value)) {
    // Object.hasOwn, not `properties[key]`: a plain-object lookup for
    // "__proto__"/"constructor"/"toString"/"valueOf"/"hasOwnProperty" resolves
    // to an inherited Object.prototype member instead of undefined, so those
    // keys would otherwise silently skip the additionalProperties check below.
    const propSchemaRaw = own(properties, key);
    if (propSchemaRaw !== undefined) {
      if (isPlainObject(propSchemaRaw)) {
        errors.push(...validateNode(propSchemaRaw, value[key], `${path}.${key}`));
      }
      continue;
    }
    if (additional === false) {
      errors.push({ path: `${path}.${key}`, message: 'additional property not allowed' });
    } else if (isPlainObject(additional)) {
      errors.push(...validateNode(additional, value[key], `${path}.${key}`));
    }
  }

  return errors;
}

function validateArray(schema: JsonSchema, value: unknown[], path: string): FieldError[] {
  const errors: FieldError[] = [];
  const itemsRaw = own(schema, 'items');
  if (isPlainObject(itemsRaw)) {
    value.forEach((item, index) => {
      errors.push(...validateNode(itemsRaw, item, `${path}[${index}]`));
    });
  }
  return errors;
}
