/**
 * Lazy internal `$ref` resolution.
 *
 * The document is deliberately *not* dereferenced up front: a recursive schema
 * (`Node.children[] -> Node`) expands without bound, turning a 30 kB file into
 * an out-of-memory kill. Each pointer is followed on demand instead, carrying
 * the chain that led to it so a cycle is a diagnostic rather than a hang.
 */
import { CommerceError } from '../core/errors';

// Bounds a pathological but non-cyclic chain of `$ref`s pointing at `$ref`s
const MAX_REF_DEPTH = 100;

export interface Dereferenced {
  readonly value: unknown;
  /** Pointers already followed, oldest first. Pass it back in to keep detecting cycles */
  readonly stack: readonly string[];
}

export function isRefNode(value: unknown): value is { $ref: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $ref?: unknown }).$ref === 'string'
  );
}

/**
 * Follows a chain of `$ref` nodes to the first value that is not one.
 *
 * Throws `CONFIG_INVALID` for a cycle, an unresolvable pointer, or an external
 * reference - the last is refused at load time too, so reaching it here means
 * a caller built a node the loader never saw.
 */
export function dereference(
  document: Record<string, unknown>,
  node: unknown,
  stack: readonly string[] = [],
): Dereferenced {
  let current = node;
  let chain = stack;
  while (isRefNode(current)) {
    const pointer = current.$ref;
    if (!pointer.startsWith('#')) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `OpenAPI document contains an external reference "${pointer}". Only internal references (#/...) are supported`,
        { details: { ref: pointer } },
      );
    }
    if (chain.includes(pointer)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `OpenAPI reference "${pointer}" is circular (${[...chain, pointer].join(' -> ')})`,
        { details: { ref: pointer, chain: [...chain, pointer] } },
      );
    }
    if (chain.length >= MAX_REF_DEPTH) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `OpenAPI reference chain exceeds ${MAX_REF_DEPTH} hops at "${pointer}"`,
        { details: { ref: pointer } },
      );
    }
    current = resolvePointer(document, pointer);
    chain = [...chain, pointer];
  }
  return { value: current, stack: chain };
}

// RFC 6901 JSON Pointer in a URI fragment: `#` is the document, `#/` its "" key
function resolvePointer(document: Record<string, unknown>, ref: string): unknown {
  const pointer = ref.slice(1);
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `OpenAPI reference "${ref}" is not a JSON Pointer. Plain names and anchors are not supported`,
      { details: { ref } },
    );
  }
  let current: unknown = document;
  for (const rawSegment of pointer.slice(1).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new CommerceError(
        'CONFIG_INVALID',
        `OpenAPI reference "${ref}" contains a malformed percent-escape`,
        { details: { ref } },
      );
    }
    // `~1` before `~0`, per RFC 6901: the other order decodes `~01` to "/"
    // instead of "~1"
    const segment = decoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      current = undefined;
    }
    if (current === undefined) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `OpenAPI reference "${ref}" does not resolve to anything in the document`,
        { details: { ref } },
      );
    }
  }
  return current;
}
