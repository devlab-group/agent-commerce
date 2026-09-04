import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../src/core/errors/index.js';
import { dereference, isRefNode, loadOpenApiDocument } from '../../../src/openapi/index.js';

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
    // stack the caller carries is what turns that into a diagnostic.
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

  it('unescapes ~1 and ~0 in pointer segments', async () => {
    const { document } = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    const { value } = dereference(document, { $ref: '#/paths/~1pets/get/operationId' });
    expect(value).toBe('listPets');
  });
});
