/**
 * OpenAPI schema -> the JSON Schema subset this gateway actually enforces.
 *
 * The honesty rule drives every decision here. `src/core`'s validator enforces
 * `type`/`properties`/`required`/`additionalProperties`/`enum`/`items` and
 * silently ignores everything else, so copying a `pattern` or a `oneOf` into a
 * generated resource would advertise validation to agents that no code
 * performs — and on a paid resource, the request the merchant's backend
 * receives is the one the buyer already paid for. Unenforceable constraints
 * are therefore dropped from the generated schema and reported, never
 * carried along quietly.
 */
import type { JsonSchema } from '../core/domain/common.js';
import { isCommerceError } from '../core/errors/index.js';
import { dereference } from './refs.js';

/** Enforced by `compileJsonSchema`. Everything else is documentation at best. */
const SUPPORTED_TYPES = new Set([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'null',
]);

/** Copied through: descriptive, never a constraint, so it cannot overstate. */
const METADATA_KEYWORDS = ['title', 'description', 'default', 'example', 'examples', 'deprecated'];

/**
 * Annotations, not constraints: dropping them changes nothing a caller could
 * observe, so they are not worth telling the operator about. Reporting them
 * would bury the keywords that *do* matter (`pattern`, `minimum`, `format`)
 * in noise, which is how a real warning gets ignored.
 */
const ANNOTATION_KEYWORDS = new Set([
  'xml',
  'externalDocs',
  'readOnly',
  'writeOnly',
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'definitions',
]);

export type SchemaConversion =
  | {
      readonly supported: true;
      readonly schema: JsonSchema;
      /** Keyword names encountered and dropped, deduplicated, in first-seen order. */
      readonly dropped: readonly string[];
    }
  | { readonly supported: false; readonly reason: string };

/** Types a path or query parameter may have: the executor stringifies one value. */
export function isPrimitiveSchema(schema: JsonSchema): boolean {
  const types = typeList(schema['type']);
  if (types === undefined) return false;
  return types.every((type) => type !== 'object' && type !== 'array' && SUPPORTED_TYPES.has(type));
}

export function convertSchema(
  document: Record<string, unknown>,
  node: unknown,
  stack: readonly string[] = [],
): SchemaConversion {
  const dropped = new Set<string>();
  try {
    const schema = convertNode(document, node, stack, dropped);
    return schema === undefined
      ? { supported: false, reason: 'schema could not be represented' }
      : { supported: true, schema, dropped: [...dropped] };
  } catch (error) {
    if (error instanceof UnsupportedSchema) return { supported: false, reason: error.message };
    // A reference cycle or a dangling pointer arrives as CONFIG_INVALID from
    // the resolver. For a *schema* that is a skip-this-operation condition,
    // not a fail-the-whole-import one: the rest of the document is fine.
    if (isCommerceError(error)) return { supported: false, reason: error.message };
    throw error;
  }
}

class UnsupportedSchema extends Error {}

function convertNode(
  document: Record<string, unknown>,
  node: unknown,
  stack: readonly string[],
  dropped: Set<string>,
): JsonSchema | undefined {
  // OpenAPI 3.1 allows boolean schemas: `true` accepts anything, `false`
  // accepts nothing — and nothing is not a request shape we can generate.
  if (node === true) return {};
  if (node === false) throw new UnsupportedSchema('schema is `false`, which accepts no value');

  const resolved = dereference(document, node, stack);
  const source = resolved.value;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new UnsupportedSchema('schema node is not an object');
  }
  const schemaNode = source as Record<string, unknown>;

  if (Array.isArray(schemaNode['allOf'])) {
    return mergeAllOf(document, schemaNode, resolved.stack, dropped);
  }
  for (const keyword of ['oneOf', 'anyOf', 'not', 'discriminator']) {
    if (Object.hasOwn(schemaNode, keyword)) {
      throw new UnsupportedSchema(
        `schema uses "${keyword}", which this gateway cannot enforce — accepting it would advertise validation that never runs`,
      );
    }
  }

  const result: Record<string, unknown> = {};
  const types = resolveTypes(schemaNode);
  if (types !== undefined) result['type'] = types.length === 1 ? types[0] : types;

  for (const keyword of METADATA_KEYWORDS) {
    if (Object.hasOwn(schemaNode, keyword)) result[keyword] = schemaNode[keyword];
  }
  if (Array.isArray(schemaNode['enum'])) result['enum'] = [...schemaNode['enum']];

  const properties = schemaNode['properties'];
  if (isRecord(properties)) {
    const converted: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(properties)) {
      const child = convertNode(document, sub, resolved.stack, dropped);
      if (child !== undefined) converted[name] = child;
    }
    result['properties'] = converted;
    if (!Object.hasOwn(schemaNode, 'additionalProperties')) result['additionalProperties'] = false;
  }

  // Independent of `properties`: `required` without them is legal, and core's
  // validator enforces it, so dropping it here would be a silent weakening.
  const required = schemaNode['required'];
  if (Array.isArray(required)) {
    const names = required.filter((name): name is string => typeof name === 'string');
    if (names.length > 0) result['required'] = names;
  }

  const additional = schemaNode['additionalProperties'];
  if (typeof additional === 'boolean') {
    result['additionalProperties'] = additional;
  } else if (additional !== undefined) {
    const child = convertNode(document, additional, resolved.stack, dropped);
    if (child !== undefined) result['additionalProperties'] = child;
  }

  const items = schemaNode['items'];
  if (Array.isArray(items)) {
    // Tuple `items` is not enforced; keeping it would look like it was.
    dropped.add('items (tuple form)');
  } else if (items !== undefined) {
    const child = convertNode(document, items, resolved.stack, dropped);
    if (child !== undefined) result['items'] = child;
  }

  for (const keyword of Object.keys(schemaNode)) {
    if (isCarriedKeyword(keyword) || ANNOTATION_KEYWORDS.has(keyword) || keyword.startsWith('x-')) {
      continue;
    }
    dropped.add(keyword);
  }

  return result;
}

function isCarriedKeyword(keyword: string): boolean {
  return (
    keyword === 'type' ||
    keyword === 'properties' ||
    keyword === 'required' ||
    keyword === 'additionalProperties' ||
    keyword === 'enum' ||
    keyword === 'items' ||
    keyword === 'nullable' ||
    keyword === '$ref' ||
    METADATA_KEYWORDS.includes(keyword)
  );
}

/**
 * OpenAPI 3.0's `nullable: true` becomes draft-2020-12's union type, which is
 * what the runtime validator understands. 3.1 already writes it that way.
 */
function resolveTypes(schema: Record<string, unknown>): string[] | undefined {
  const declared = typeList(schema['type']);
  if (declared === undefined) return undefined;
  const known = declared.filter((type) => SUPPORTED_TYPES.has(type));
  if (known.length === 0) {
    throw new UnsupportedSchema(`schema type "${String(schema['type'])}" is not a JSON type`);
  }
  if (schema['nullable'] === true && !known.includes('null')) known.push('null');
  return known;
}

function typeList(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return raw as string[];
  }
  return undefined;
}

/**
 * A simple `allOf` of object schemas is merged; anything else is refused.
 *
 * Merging is only safe while the branches agree — two branches declaring the
 * same property differently have a meaning ("both must hold") that this
 * validator cannot express, and picking one would quietly accept requests the
 * API rejects, or reject ones it accepts.
 */
function mergeAllOf(
  document: Record<string, unknown>,
  schema: Record<string, unknown>,
  stack: readonly string[],
  dropped: Set<string>,
): JsonSchema {
  const branches = schema['allOf'] as readonly unknown[];
  const siblings = { ...schema };
  delete siblings['allOf'];

  const merged: Record<string, unknown> = { type: 'object', properties: {}, required: [] };
  const properties = merged['properties'] as Record<string, unknown>;
  const required = new Set<string>();

  const parts = [...branches, ...(Object.keys(siblings).length > 0 ? [siblings] : [])];
  for (const branch of parts) {
    const converted = convertNode(document, branch, stack, dropped);
    if (converted === undefined) throw new UnsupportedSchema('allOf branch is empty');
    const types = typeList(converted['type']);
    if (types !== undefined && !types.includes('object')) {
      throw new UnsupportedSchema('allOf mixes object and non-object schemas');
    }
    const branchProperties = converted['properties'];
    if (isRecord(branchProperties)) {
      for (const [name, sub] of Object.entries(branchProperties)) {
        const existing = properties[name];
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(sub)) {
          throw new UnsupportedSchema(
            `allOf branches declare property "${name}" differently, which cannot be merged`,
          );
        }
        properties[name] = sub;
      }
    }
    for (const name of Array.isArray(converted['required']) ? converted['required'] : []) {
      if (typeof name === 'string') required.add(name);
    }
    for (const keyword of ['enum', 'items']) {
      if (Object.hasOwn(converted, keyword)) {
        throw new UnsupportedSchema(`allOf branch uses "${keyword}", which cannot be merged`);
      }
    }
    if (typeof converted['description'] === 'string' && merged['description'] === undefined) {
      merged['description'] = converted['description'];
    }
  }

  if (required.size > 0) merged['required'] = [...required];
  else delete merged['required'];
  merged['additionalProperties'] = false;
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
