import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../src/core/errors/index.js';
import {
  type DiscoverOptions,
  type DiscoveryResult,
  discoverOperations,
  loadOpenApiDocument,
} from '../../../src/openapi/index.js';

const fixture = (name: string): string =>
  join(fileURLToPath(new URL('./fixtures/', import.meta.url)), name);

async function discover(name: string, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  return discoverOperations(await loadOpenApiDocument(fixture(name)), options);
}

const codes = (result: DiscoveryResult): string[] => result.diagnostics.map((d) => d.code);
const ids = (result: DiscoveryResult): string[] => result.operations.map((o) => o.resourceId);

describe('discoverOperations', () => {
  it('uses operationId, falls back to method_path, and normalises both', async () => {
    const result = await discover('petstore-3.0.yaml');
    expect(ids(result)).toEqual(['listPets', 'post_pets', 'getPet']);
  });

  it('normalises an operationId that is not a legal resource id', async () => {
    const result = await discover('minimal-3.1.json');
    // "list things!" - the space and "!" are not in the id character set.
    expect(ids(result)).toEqual(['list_things']);
  });

  it('generates the same ids on every run (no counters, no iteration order)', async () => {
    const first = await discover('petstore-3.0.yaml');
    const second = await discover('petstore-3.0.yaml');
    expect(ids(first)).toEqual(ids(second));
  });

  it('warns about an unsupported HTTP method instead of coercing it', async () => {
    const result = await discover('petstore-3.0.yaml');
    const head = result.diagnostics.find((d) => d.code === 'unsupported-method');
    expect(head?.operation).toBe('HEAD /pets/{petId}');
    expect(head?.severity).toBe('warning');
  });

  it('fails the import when two operations claim one resource id', async () => {
    try {
      await discover('collision.yaml');
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error) && error.code).toBe('CONFIG_INVALID');
      if (isCommerceError(error)) {
        expect(error.message).toContain('get_a_b');
        expect(error.message).toContain('GET /a/b');
        expect(error.message).toContain('GET /a-b');
      }
    }
  });

  it('takes name from summary, then operationId, then the resource id', async () => {
    const result = await discover('petstore-3.0.yaml');
    const [list, create, get] = result.operations;
    expect(list?.name).toBe('List pets');
    expect(list?.description).toBe('Every pet, paged.');
    expect(create?.name).toBe('Create a pet');
    expect(get?.name).toBe('getPet');
    expect(get?.description).toBeUndefined();
  });

  it('resolves the root server and keeps {param} templates literal', async () => {
    const result = await discover('petstore-3.0.yaml');
    expect(result.operations.map((o) => o.backendUrl)).toEqual([
      'https://api.example.com/v1/pets',
      'https://api.example.com/v1/pets',
      'https://api.example.com/v1/pets/{petId}',
    ]);
  });

  it('prefers an operation server over a path-item server over the root', async () => {
    const result = await discover('variables-3.2.yaml');
    const byId = Object.fromEntries(result.operations.map((o) => [o.resourceId, o.backendUrl]));
    expect(byId['listReports']).toBe('https://reports.example.com/reports');
    expect(byId['createReport']).toBe('https://write.example.com/reports');
    expect(byId['health']).toBe('https://eu.api.example.com/v1/health');
  });

  it('substitutes server-variable defaults and says that it did', async () => {
    const result = await discover('variables-3.2.yaml');
    const warning = result.diagnostics.find((d) => d.code === 'server-variable-default');
    expect(warning?.message).toContain('region=eu');
    expect(warning?.message).toContain('stage=v1');
  });

  it('lets --base-url override every declared server', async () => {
    const result = await discover('variables-3.2.yaml', { baseUrl: 'http://localhost:3000/api/' });
    expect(result.operations.map((o) => o.backendUrl).sort()).toEqual([
      'http://localhost:3000/api/health',
      'http://localhost:3000/api/reports',
      'http://localhost:3000/api/reports',
    ]);
    expect(codes(result)).not.toContain('server-variable-default');
  });

  it('rejects a --base-url that is not an absolute http(s) URL', async () => {
    await expect(discover('petstore-3.0.yaml', { baseUrl: '/v1' })).rejects.toThrowError();
  });

  it('rejects a --base-url carrying a query string or fragment', async () => {
    // Concatenation puts the operation path AFTER the query, so the resulting
    // URL parses and calls the wrong endpoint.
    await expect(
      discover('petstore-3.0.yaml', { baseUrl: 'https://api.example.com/v1?apikey=SECRET' }),
    ).rejects.toThrowError();
    await expect(
      discover('petstore-3.0.yaml', { baseUrl: 'https://api.example.com/v1#frag' }),
    ).rejects.toThrowError();
  });

  it('skips an operation whose only server URL is relative, and says to pass --base-url', async () => {
    const result = await discover('relative-server.yaml');
    expect(result.operations).toHaveLength(0);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe('relative-server-url');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('--base-url');
  });

  it('imports the same relative-server document once --base-url is supplied', async () => {
    const result = await discover('relative-server.yaml', { baseUrl: 'https://api.example.com' });
    expect(result.operations.map((o) => o.backendUrl)).toEqual(['https://api.example.com/a']);
    expect(result.diagnostics).toEqual([]);
  });

  it('collects path-item parameters before operation parameters', async () => {
    const result = await discover('petstore-3.0.yaml');
    const get = result.operations.find((o) => o.resourceId === 'getPet');
    expect(get?.parameters).toEqual([
      { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    const list = result.operations.find((o) => o.resourceId === 'listPets');
    expect(list?.parameters).toEqual([{ name: 'limit', in: 'query', schema: { type: 'integer' } }]);
  });

  it('carries the request body node unresolved, for the schema converter', async () => {
    const result = await discover('petstore-3.0.yaml');
    const create = result.operations.find((o) => o.resourceId === 'post_pets');
    expect(create?.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
    });
  });
});
