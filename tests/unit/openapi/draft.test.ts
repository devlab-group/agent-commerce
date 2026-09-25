import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/schema.js';
import {
  buildResourceDrafts,
  type ImportResult,
  type LoadedOpenApiDocument,
  loadOpenApiDocument,
  renderResourcesYaml,
} from '../../../src/openapi/index.js';
import { validRawConfig } from '../config/fixtures.js';

const fixture = (name: string): string =>
  join(fileURLToPath(new URL('./fixtures/', import.meta.url)), name);

let loaded: LoadedOpenApiDocument;
let result: ImportResult;

beforeAll(async () => {
  loaded = await loadOpenApiDocument(fixture('responses-3.1.yaml'));
  result = buildResourceDrafts(loaded);
});

const draft = (id: string) => result.drafts.find((entry) => entry.id === id);
const diagnostics = (id: string) => result.diagnostics.filter((d) => d.operation === id);
const resource = (id: string) => draft(id)?.resource as Record<string, unknown>;

describe('buildResourceDrafts', () => {
  it('takes the 200 JSON response as the output schema', () => {
    expect(resource('getOrder')['output']).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, total: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('warns when several 2xx responses carry a body, naming the one it used', () => {
    const warning = diagnostics('getOrder').find((d) => d.code === 'multiple-success-responses');
    expect(warning?.message).toContain('used 200');
  });

  it('falls back to 201 and accepts a vendor +json response', () => {
    expect(resource('createOrder')['output']).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('omits output for a 204 response', () => {
    expect(resource('cancelOrder')).not.toHaveProperty('output');
  });

  it('omits output when the success response is not JSON', () => {
    expect(resource('ping')).not.toHaveProperty('output');
  });

  it('dereferences OpenAPI 3.2 response and media-type objects', async () => {
    const referenced = buildResourceDrafts(
      await loadOpenApiDocument(fixture('referenced-media-3.2.yaml')),
    );

    expect(referenced.drafts[0]?.resource['output']).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('warns when the selected JSON response has no schema', () => {
    const withoutSchema = buildResourceDrafts({
      version: '3.1',
      sourcePath: '/tmp/no-schema.yaml',
      document: {
        openapi: '3.1.0',
        info: { title: 'No output schema', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/status': {
            get: {
              operationId: 'status',
              responses: {
                '200': { description: 'ok', content: { 'application/json': {} } },
              },
            },
          },
        },
      },
    });

    expect(withoutSchema.drafts[0]?.resource).not.toHaveProperty('output');
    expect(withoutSchema.diagnostics.map(({ code }) => code)).toContain('missing-output-schema');
  });

  it('omits an output schema it cannot represent, and keeps the operation', () => {
    expect(draft('union')).toBeDefined();
    expect(resource('union')).not.toHaveProperty('output');
    expect(diagnostics('union').map((d) => d.code)).toContain('unsupported-output-schema');
  });

  it('reports dropped constraints from input and output together', () => {
    const warning = diagnostics('getOrder').find((d) => d.code === 'unenforced-schema-constraints');
    expect(warning?.message).toContain('minimum');
  });

  it('warns about backend authentication without importing any credential', () => {
    const warning = diagnostics('getOrder').find(
      (d) => d.code === 'backend-authentication-required',
    );
    expect(warning?.message).toContain('credentials were not imported');
    // The API key scheme names an X-Api-Key header; it must not become input.
    expect(JSON.stringify(resource('getOrder'))).not.toContain('X-Api-Key');
    expect(JSON.stringify(resource('getOrder'))).not.toContain('apiKey');
  });

  it('does not warn for an operation that opts out of security', () => {
    expect(diagnostics('createOrder').map((d) => d.code)).not.toContain(
      'backend-authentication-required',
    );
    // `security: [{}]` means optional, not required.
    expect(diagnostics('ping').map((d) => d.code)).not.toContain('backend-authentication-required');
  });

  it('never infers pricing, exposure or payments', () => {
    for (const entry of result.drafts) {
      expect(entry.resource).not.toHaveProperty('pricing');
      expect(entry.resource).not.toHaveProperty('expose');
      expect(entry.resource).not.toHaveProperty('payments');
      expect(entry.review.join(' ')).toContain('REVIEW');
    }
  });

  it('writes policy only when the operator supplied it', () => {
    const withPolicy = buildResourceDrafts(loaded, {
      policy: { pricing: { type: 'free' }, expose: ['http', 'mcp'] },
    });
    const order = withPolicy.drafts.find((entry) => entry.id === 'getOrder');
    expect(order?.resource['pricing']).toEqual({ type: 'free' });
    expect(order?.resource['expose']).toEqual(['http', 'mcp']);
    expect(order?.review.join(' ')).not.toContain('REVIEW');
  });

  it('ignores vendor extensions instead of letting them alter the resource', () => {
    expect(JSON.stringify(resource('getOrder'))).not.toContain('x-internal-cost');
  });

  it('filters by operation id and reports one that matched nothing', () => {
    const filtered = buildResourceDrafts(loaded, {
      include: { operationIds: ['getOrder', 'nope'] },
    });
    expect(filtered.drafts.map((entry) => entry.id)).toEqual(['getOrder']);
    expect(filtered.unmatchedOperationIds).toEqual(['nope']);
  });

  it('keeps discovery warnings about unselected operations out of a filtered result', async () => {
    const petstore = await loadOpenApiDocument(fixture('petstore-3.0.yaml'));
    const all = buildResourceDrafts(petstore);
    expect(all.diagnostics.map((d) => d.code)).toContain('unsupported-method');
    const filtered = buildResourceDrafts(petstore, { include: { operationIds: ['listPets'] } });
    expect(filtered.diagnostics.map((d) => d.code)).not.toContain('unsupported-method');
  });

  it('filters by tag, OR-ing several', () => {
    const filtered = buildResourceDrafts(loaded, { include: { tags: ['read', 'write'] } });
    expect(filtered.drafts.map((entry) => entry.id)).toEqual(['getOrder', 'cancelOrder']);
  });
});

describe('renderResourcesYaml', () => {
  it('is byte-identical across runs of the same document', async () => {
    const again = buildResourceDrafts(await loadOpenApiDocument(fixture('responses-3.1.yaml')));
    expect(renderResourcesYaml(again)).toBe(renderResourcesYaml(result));
  });

  it('writes a reviewable fragment with the review comments above each resource', () => {
    const yaml = renderResourcesYaml(result);
    expect(yaml).toContain('# Generated by agent-commerce import openapi');
    expect(yaml).toContain('resources:');
    const commentIndex = yaml.indexOf('REVIEW: pricing and exposure are not inferred');
    expect(commentIndex).toBeGreaterThan(-1);
    expect(commentIndex).toBeLessThan(yaml.indexOf('getOrder:'));
    expect(yaml).toContain('#   pricing: { type: free }');
    expect(yaml).toContain('#   expose: [http]           # http | mcp | a2a | acp');
    // Fixed pricing without payments fails config validation
    expect(yaml).toContain('with payments: [x402]');
    expect(yaml).toContain('backend authentication');
  });

  it('produces a fragment that loads once pricing and exposure are chosen', () => {
    const withPolicy = buildResourceDrafts(loaded, {
      policy: { pricing: { type: 'free' }, expose: ['http'] },
    });
    const raw = validRawConfig();
    const resources: Record<string, unknown> = {};
    for (const entry of withPolicy.drafts) resources[entry.id] = entry.resource;
    raw['resources'] = resources;

    const config = parseConfig(raw, {});
    expect(config.resources.map((r) => r.id)).toEqual(withPolicy.drafts.map((d) => d.id));
    const order = config.resources.find((r) => r.id === 'getOrder');
    expect(order?.handler.url).toBe('https://api.example.com/orders/{orderId}');
    expect(order?.handler.inputBindings).toEqual({ path: 'path' });
  });
});
