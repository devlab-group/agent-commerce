// Example values and the published object form of a resource's input schema,
// shared by the A2A Agent Card, MCP tools and x402 Bazaar metadata
import type { JsonSchema } from '../domain/common';
import { AUTHORIZATION_INPUT_FIELD, PAYMENT_INPUT_FIELD } from '../domain/wire';
import { isRecord } from '../is-record';

/**
 * Build a sample using the first schema example, then its default or first
 * enum value, otherwise a value for the declared type. Generated objects use
 * required properties only; explicit examples, defaults and enum values are
 * returned unchanged. Other constraints may require different input.
 */
export function exampleValue(schema: unknown, name: string): unknown {
  if (!isRecord(schema)) return `<${name}>`;
  const examples = schema['examples'];
  if (Array.isArray(examples) && examples.length > 0) return examples[0];
  if (schema['default'] !== undefined) return schema['default'];
  const allowed = schema['enum'];
  if (Array.isArray(allowed) && allowed.length > 0) return allowed[0];
  const declared = schema['type'];
  const type: unknown = Array.isArray(declared) ? declared[0] : declared;
  switch (type) {
    case 'object':
      return exampleObject(schema);
    case 'array':
      return schema['items'] !== undefined ? [exampleValue(schema['items'], name)] : [];
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return `<${name}>`;
  }
}

/** An object holding an example of each required property, without the reserved fields */
export function exampleObject(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  const example: Record<string, unknown> = {};
  for (const key of required) {
    // The reserved fields carry proofs, which no example can hold
    if (typeof key !== 'string' || key === PAYMENT_INPUT_FIELD || key === AUTHORIZATION_INPUT_FIELD)
      continue;
    example[key] = exampleValue(properties[key], key);
  }
  return example;
}

/** An object input schema before adding reserved payment and authorization fields */
export interface ObjectInputSchema {
  readonly [keyword: string]: unknown;
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Record<string, unknown>>>;
  readonly required?: readonly string[];
}

/**
 * Normalize a resource input schema for MCP, before adding reserved fields.
 * Preserve other keywords while setting `type` to `'object'`, retaining only
 * object-valued `properties` and string entries in `required`.
 */
export function objectInputSchema(schema: JsonSchema | undefined): ObjectInputSchema {
  const base = isRecord(schema) ? schema : {};
  const properties = isRecord(base['properties'])
    ? Object.fromEntries(
        Object.entries(base['properties']).filter(
          (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
        ),
      )
    : {};
  const required = Array.isArray(base['required'])
    ? base['required'].filter((v): v is string => typeof v === 'string')
    : [];
  const extra = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) => key !== 'type' && key !== 'properties' && key !== 'required',
    ),
  );
  return {
    ...extra,
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
