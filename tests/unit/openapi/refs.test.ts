import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../src/core/errors';
import { dereference, isRefNode, loadOpenApiDocument } from '../../../src/openapi';

const fixture = (name: string): string =>
  join(fileURLToPath(new URL('./fixtures/', import.meta.url)), name);

function expectInvalid(run: () => unknown): string {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(isCommerceError(error) && error.code).toBe('CONFIG_INVALID');
    return error instanceof Error ? error.message : String(error);
  }
}

describe('dereference', () => {
  it('resolves an internal pointer', async () => {
    const { document } = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    const { value, stack } = dereference(document, { $ref: '#/components/schemas/Pet' });
    expect(value).toEqual({ type: 'object', properties: { name: { type: 'string' } } });
    expect(stack).toEqual(['#/components/schemas/Pet']);
  });

  it('returns a non-reference node untouched', async () => {
    const { document } = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    expect(dereference(document, { type: 'string' }).value).toEqual({ type: 'string' });
    expect(isRefNode({ type: 'string' })).toBe(false);
  });

  it('detects a reference cycle instead of hanging', async () => {
    const { document } = await loadOpenApiDocument(fixture('cyclic-ref.yaml'));
    const message = expectInvalid(() =>
      dereference(document, { $ref: '#/components/schemas/Node' }),
    );
    expect(message).toContain('circular');
  });

  it('detects a cycle reached through a caller-carried stack', async () => {
    const { document } = await loadOpenApiDocument(fixture('cyclic-ref.yaml'));
    const items = { $ref: '#/components/schemas/Tree' };
    const first = dereference(document, items);
    expect(isRefNode(first.value)).toBe(false);
    // Walking into Tree.properties.children.items reaches Tree again; the
    // stack the caller carries is what turns that into a diagnostic
    expectInvalid(() => dereference(document, items, first.stack));
  });

  it('rejects a pointer that resolves to nothing', async () => {
    const { document } = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    const message = expectInvalid(() =>
      dereference(document, { $ref: '#/components/schemas/Missing' }),
    );
    expect(message).toContain('does not resolve');
  });

  it('rejects an external reference even when handed one directly', async () => {
    const { document } = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    const message = expectInvalid(() =>
      dereference(document, { $ref: 'https://example.com/x.yaml#/Thing' }),
    );
    expect(message).toContain('external reference');
  });

  it('rejects a malformed percent-escape as CONFIG_INVALID, not a URIError', () => {
    const message = expectInvalid(() =>
      dereference({ components: {} }, { $ref: '#/components/%zz' }),
    );
    expect(message).toContain('malformed percent-escape');
  });

  it('reads `#` as the document and `#/` as its "" key (RFC 6901)', () => {
    const document = { '': 'empty key', other: 1 };
    expect(dereference(document, { $ref: '#' }).value).toBe(document);
    expect(dereference(document, { $ref: '#/' }).value).toBe('empty key');
  });

  it('unescapes ~1 and ~0 in pointer segments', async () => {
    const { document } = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    const { value } = dereference(document, { $ref: '#/paths/~1pets/get/operationId' });
    expect(value).toBe('listPets');

    const escaped = { 'a/b': 'slash', 'a~b': 'tilde', 'a~1b': 'literal' };
    expect(dereference(escaped, { $ref: '#/a~0b' }).value).toBe('tilde');
    // ~1 is replaced first, so ~01 is a literal "~1", never "/"
    expect(dereference(escaped, { $ref: '#/a~01b' }).value).toBe('literal');
  });

  it('percent-decodes a segment before looking it up', () => {
    const document = { paths: { '/users/{id}': 'user' } };
    expect(dereference(document, { $ref: '#/paths/~1users~1%7Bid%7D' }).value).toBe('user');
  });

  it('indexes into an array', () => {
    const document = { servers: [{ url: 'a' }, { url: 'b' }] };
    expect(dereference(document, { $ref: '#/servers/1' }).value).toEqual({ url: 'b' });
  });

  it('never resolves a pointer through an inherited member', () => {
    // "#/__proto__" would otherwise become Object.prototype, an empty schema
    // that accepts any input
    const document = { components: { schemas: { A: { type: 'string' } } }, list: ['x'] };
    for (const ref of [
      '#/__proto__',
      '#/components/schemas/constructor',
      '#/components/toString',
      '#/list/length',
    ]) {
      expect(expectInvalid(() => dereference(document, { $ref: ref }))).toContain(
        'does not resolve',
      );
    }
  });

  it('refuses a plain-name fragment, which is not a JSON Pointer', () => {
    const message = expectInvalid(() => dereference({ Pet: {} }, { $ref: '#Pet' }));
    expect(message).toContain('not a JSON Pointer');
  });

  it('follows a chain of up to 100 references and refuses a longer one', () => {
    // hop-0 -> hop-1 -> ... -> the schema: `hops` references in all
    const chain = (hops: number) => {
      const refs: Record<string, unknown> = { [`hop-${hops - 1}`]: { type: 'string' } };
      for (let i = 0; i < hops - 1; i++) refs[`hop-${i}`] = { $ref: `#/refs/hop-${i + 1}` };
      return { refs };
    };
    const start = { $ref: '#/refs/hop-0' };
    expect(dereference(chain(100), start).value).toEqual({ type: 'string' });
    expect(expectInvalid(() => dereference(chain(101), start))).toContain('exceeds 100 hops');
  });
});
