// A resource's input schema: the default closed object and the keywords the validator supports
import { CommerceError } from '../../core';
import { isObjectSchemaNode } from '../../core/execution';
import { isRecord } from '../../core/is-record';

/**
 * Closes every object schema at every depth: a node without
 * `additionalProperties` gets `false`, so unknown keys never reach the
 * merchant's API. An explicit value, including `true`, is kept.
 *
 * JSON Schema itself defaults to open, and core's validator enforces
 * `additionalProperties` only where a node states it, so this recurses into
 * `properties`, `items` and schema-valued `additionalProperties`, the same
 * places the validator descends. Object-ness comes from `isObjectSchemaNode`,
 * the validator's own definition.
 */
export function defaultClosedObjectSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const isObjectSchema = isObjectSchemaNode(schema);
  const result: Record<string, unknown> = { ...schema };

  if (isObjectSchema) {
    const properties = schema['properties'];
    if (isRecord(properties)) {
      result['properties'] = Object.fromEntries(
        Object.entries(properties).map(([key, sub]) => [
          key,
          isRecord(sub) ? defaultClosedObjectSchema(sub) : sub,
        ]),
      );
    }
    if (!Object.hasOwn(schema, 'additionalProperties')) {
      result['additionalProperties'] = false;
    }
  }

  const items = schema['items'];
  if (isRecord(items)) {
    result['items'] = defaultClosedObjectSchema(items);
  }

  // `additionalProperties: {schema}` (a map of typed objects) is closed too.
  // Not conditional on `isObjectSchema`: the validator applies the subschema
  // wherever it finds one.
  const additional = schema['additionalProperties'];
  if (isRecord(additional)) {
    result['additionalProperties'] = defaultClosedObjectSchema(additional);
  }

  return result;
}

// The input schema of a resource that declares no `input:`. Declaring nothing
// accepts nothing: without this, `compileJsonSchema(undefined)` would accept
// any input and forward every key to the backend. A no-argument resource
// omitting `input:` is a legitimate shape, so it is not refused.
export const EMPTY_CLOSED_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// Keywords core's validator ignores (see `execution/validation.ts` for the
// enforced subset). Config warns at load, since an operator who writes
// `pattern` cannot otherwise tell that it is not enforced.
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  'pattern',
  'minLength',
  'maxLength',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  '$ref',
  'const',
  'patternProperties',
  'minItems',
  'maxItems',
  'uniqueItems',
];

// `type` set to something that rules out "object". No `type` at all does not
// exclude it: the validator treats `properties`/`required` alone as an object
// schema.
function excludesObjectType(schema: Record<string, unknown>): boolean {
  const type = schema['type'];
  if (type === undefined || type === 'object') return false;
  if (Array.isArray(type)) return !type.includes('object');
  return true;
}

/**
 * Walks a resource's input schema once. Warns about unenforced keywords and
 * tuple `items`. Rejects a node whose `type` rules out "object" while it
 * declares `properties` or `required`, which then go unchecked (often a
 * copy-pasted sibling whose `type` was never updated), and a closed node
 * requiring a property it never declares, which no input can satisfy.
 */
export function validateResourceSchemaKeywords(
  id: string,
  path: string,
  schema: Record<string, unknown>,
): void {
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      console.warn(
        `[agent-commerce] resource "${id}" ${path} uses JSON Schema keyword "${keyword}", which this gateway does not enforce (see src/core/execution/validation.ts for the supported subset). Remove it or treat it as documentation only.`,
      );
    }
  }
  if (
    (Object.hasOwn(schema, 'properties') || Object.hasOwn(schema, 'required')) &&
    excludesObjectType(schema)
  ) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" ${path} declares "properties" and/or "required" but its "type" (${JSON.stringify(schema['type'])}) does not include "object" - the validator will never route a value through either check under that type, so this schema claims to constrain input it does not actually enforce. Remove "properties"/"required", or include "object" in "type".`,
      { details: { path: `resources.${id}.${path}`, resourceId: id } },
    );
  }
  // A closed node that requires a property it never declares rejects that
  // property as unknown, so no input can satisfy it and every call would 400.
  // Only when the node is closed: an explicit `additionalProperties`
  // other than `false` leaves the name reachable.
  const requiredRaw = schema['required'];
  const closed = !Object.hasOwn(schema, 'additionalProperties')
    ? true
    : schema['additionalProperties'] === false;
  if (Array.isArray(requiredRaw) && closed && isObjectSchemaNode(schema)) {
    const declared = isRecord(schema['properties']) ? schema['properties'] : {};
    const undeclared = requiredRaw.filter(
      (name): name is string => typeof name === 'string' && !Object.hasOwn(declared, name),
    );
    if (undeclared.length > 0) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" ${path} lists ${undeclared.map((n) => `"${n}"`).join(', ')} in "required" but does not declare ${undeclared.length === 1 ? 'it' : 'them'} in "properties". The schema is closed (additionalProperties: false), so ${undeclared.length === 1 ? 'that name is' : 'those names are'} rejected as an unknown key and no input can ever satisfy this schema. Declare ${undeclared.length === 1 ? 'it' : 'them'} in "properties".`,
        { details: { path: `resources.${id}.${path}`, resourceId: id, undeclared } },
      );
    }
  }

  const properties = schema['properties'];
  if (isRecord(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (isRecord(sub)) validateResourceSchemaKeywords(id, `${path}.properties.${key}`, sub);
    }
  }
  const additional = schema['additionalProperties'];
  if (isRecord(additional)) {
    validateResourceSchemaKeywords(id, `${path}.additionalProperties`, additional);
  }
  const items = schema['items'];
  if (isRecord(items)) {
    validateResourceSchemaKeywords(id, `${path}.items`, items);
  } else if (Array.isArray(items)) {
    // Tuple-form `items` is valid JSON Schema, but the validator supports only
    // one schema for every element, so a tuple enforces nothing
    console.warn(
      `[agent-commerce] resource "${id}" ${path}.items is a tuple (an array of schemas), which this gateway does not enforce - only a single schema applied to every array element is supported (see src/core/execution/validation.ts). Each position's schema is unenforced; treat it as documentation only.`,
    );
  }
}
