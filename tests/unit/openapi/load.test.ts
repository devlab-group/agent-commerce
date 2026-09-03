import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCommerceError } from '../../../src/core/errors/index.js';
import { loadOpenApiDocument, MAX_SOURCE_BYTES } from '../../../src/openapi/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name: string): string => join(FIXTURES, name);

async function expectConfigInvalid(load: Promise<unknown>): Promise<string> {
  try {
    await load;
    expect.unreachable();
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    if (!isCommerceError(error)) throw error;
    expect(error.code).toBe('CONFIG_INVALID');
    return error.message;
  }
}

describe('loadOpenApiDocument', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a 3.0 YAML document', async () => {
    const loaded = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    expect(loaded.version).toBe('3.0');
    expect(loaded.sourcePath).toContain('petstore-3.0.yaml');
    // The document is kept verbatim - references are NOT expanded up front.
    const paths = loaded.document['paths'] as Record<
      string,
      Record<string, { requestBody: { content: Record<string, { schema: unknown }> } }>
    >;
    const pet = paths['/pets']?.['post']?.requestBody.content['application/json']?.schema;
    expect(pet).toEqual({ $ref: '#/components/schemas/Pet' });
  });

  it('loads a 3.1 JSON document', async () => {
    const loaded = await loadOpenApiDocument(fixture('minimal-3.1.json'));
    expect(loaded.version).toBe('3.1');
  });

  it('loads a 3.2 YAML document', async () => {
    const loaded = await loadOpenApiDocument(fixture('variables-3.2.yaml'));
    expect(loaded.version).toBe('3.2');
  });

  it('rejects a directory', async () => {
    const message = await expectConfigInvalid(loadOpenApiDocument(FIXTURES));
    expect(message).toContain('is a directory');
  });

  it('rejects an unreadable path', async () => {
    await expectConfigInvalid(loadOpenApiDocument(fixture('does-not-exist.yaml')));
  });

  it('rejects an unsupported extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oac-openapi-'));
    const path = join(dir, 'spec.txt');
    await writeFile(path, 'openapi: 3.1.0\n');
    const message = await expectConfigInvalid(loadOpenApiDocument(path));
    expect(message).toContain('unsupported extension');
  });

  it('rejects an empty document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oac-openapi-'));
    const path = join(dir, 'spec.yaml');
    await writeFile(path, '   \n');
    const message = await expectConfigInvalid(loadOpenApiDocument(path));
    expect(message).toContain('is empty');
  });

  it('rejects a document over the size limit before parsing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oac-openapi-'));
    const path = join(dir, 'huge.yaml');
    await writeFile(path, `openapi: 3.1.0\n# ${'x'.repeat(MAX_SOURCE_BYTES)}\n`);
    const message = await expectConfigInvalid(loadOpenApiDocument(path));
    expect(message).toContain('over the');
  });

  it('rejects invalid YAML', async () => {
    const message = await expectConfigInvalid(loadOpenApiDocument(fixture('invalid.yaml')));
    expect(message).toContain('not valid YAML');
  });

  it('rejects invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oac-openapi-'));
    const path = join(dir, 'spec.json');
    await writeFile(path, '{ "openapi": "3.1.0", }');
    const message = await expectConfigInvalid(loadOpenApiDocument(path));
    expect(message).toContain('not valid JSON');
  });

  it('rejects a document that is not a valid OpenAPI description', async () => {
    const message = await expectConfigInvalid(loadOpenApiDocument(fixture('not-openapi.yaml')));
    expect(message).toContain('not a valid OpenAPI');
  });

  it('rejects Swagger 2.0 by name', async () => {
    const message = await expectConfigInvalid(loadOpenApiDocument(fixture('swagger-2.0.yaml')));
    expect(message).toContain('Swagger 2.0');
  });

  it('rejects an unsupported OpenAPI version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oac-openapi-'));
    const path = join(dir, 'spec.yaml');
    await writeFile(path, 'openapi: 4.0.0\ninfo:\n  title: t\n  version: "1"\npaths: {}\n');
    const message = await expectConfigInvalid(loadOpenApiDocument(path));
    expect(message).toContain('not supported');
  });

  it('rejects an external HTTP $ref without making a single outbound request', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('the importer must not perform network requests');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const message = await expectConfigInvalid(
      loadOpenApiDocument(fixture('external-http-ref.yaml')),
    );
    expect(message).toContain('external reference');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an external local-file $ref', async () => {
    const message = await expectConfigInvalid(
      loadOpenApiDocument(fixture('external-file-ref.yaml')),
    );
    expect(message).toContain('./common.yaml#/Thing');
  });

  it('accepts a document whose internal references are cyclic - resolution is lazy', async () => {
    const loaded = await loadOpenApiDocument(fixture('cyclic-ref.yaml'));
    expect(loaded.version).toBe('3.1');
  });
});
