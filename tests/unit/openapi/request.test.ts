import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/schema.js';
import { validateBackendRequestShape } from '../../../src/core/execution/index.js';
import {
  discoverOperations,
  type LoadedOpenApiDocument,
  loadOpenApiDocument,
  mapRequest,
  type RequestMapping,
} from '../../../src/openapi/index.js';
import { validRawConfig } from '../config/fixtures.js';

const fixture = (name: string): string =>
  join(fileURLToPath(new URL('./fixtures/', import.meta.url)), name);

let loaded: LoadedOpenApiDocument;
let mappings: Map<string, RequestMapping>;

beforeAll(async () => {
  loaded = await loadOpenApiDocument(fixture('request-shapes-3.1.yaml'));
  const { operations } = discoverOperations(loaded);
  mappings = new Map(
    operations.map((operation) => [operation.resourceId, mapRequest(loaded, operation)]),
  );
});

function mapping(id: string): RequestMapping {
  const found = mappings.get(id);
  if (found === undefined) throw new Error(`no operation "${id}"`);
  return found;
}

function properties(id: string): Record<string, Record<string, unknown>> {
  const result = mapping(id);
  if (!result.supported) throw new Error(`operation "${id}" was skipped`);
  return result.inputSchema['properties'] as Record<string, Record<string, unknown>>;
}

const codes = (id: string): string[] => mapping(id).diagnostics.map((d) => d.code);

describe('mapRequest', () => {
  it('maps path + query + body into namespaced groups with bindings', () => {
    const result = mapping('createOrder');
    expect(result.supported).toBe(true);
    if (!result.supported) return;

    expect(result.inputSchema).toEqual({
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: { userId: { type: 'string', description: 'overridden by the operation' } },
          required: ['userId'],
          additionalProperties: false,
        },
        query: {
          type: 'object',
          properties: { trace: { type: 'string' }, notify: { type: 'boolean' } },
          required: ['notify'],
          additionalProperties: false,
        },
        body: {
          type: 'object',
          properties: { productId: { type: 'string' }, quantity: { type: 'integer' } },
          required: ['productId'],
          additionalProperties: false,
        },
      },
      required: ['path', 'query', 'body'],
      additionalProperties: false,
    });
    expect(result.inputBindings).toEqual({ path: 'path', query: 'query', body: 'body' });
    expect(result.contentType).toBeUndefined();
  });

  it('inherits path-item parameters and lets the operation override by name + in', () => {
    const path = properties('createOrder')['path'];
    // The path item declares "from the path item"; the operation wins.
    expect(path).toMatchObject({
      properties: { userId: { description: 'overridden by the operation' } },
    });
    // "trace" comes only from the path item and still survives the merge.
    expect(properties('createOrder')['query']?.['properties']).toHaveProperty('trace');
  });

  it('maps a path-only operation', () => {
    const result = mapping('getItem');
    expect(result.supported && result.inputBindings).toEqual({ path: 'path' });
    expect(Object.keys(properties('getItem'))).toEqual(['path']);
    expect(result.supported && result.inputSchema['required']).toEqual(['path']);
  });

  it('maps path + optional query, requiring only the path group', () => {
    const result = mapping('listOrders');
    expect(result.supported && result.inputBindings).toEqual({ path: 'path', query: 'query' });
    expect(result.supported && result.inputSchema['required']).toEqual(['path']);
  });

  it('maps a query-only operation and requires the group only when a member is required', () => {
    const result = mapping('search');
    expect(result.supported && result.inputBindings).toEqual({ query: 'query' });
    expect(properties('search')['query']).toEqual({
      type: 'object',
      properties: { q: { type: 'string' }, page: { type: 'integer' } },
      required: ['q'],
      additionalProperties: false,
    });
    expect(result.supported && result.inputSchema['required']).toEqual(['query']);
  });

  it('maps a body-only operation and keeps a vendor +json content type', () => {
    const result = mapping('createReport');
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.inputBindings).toEqual({ body: 'body' });
    expect(result.contentType).toBe('application/vnd.acme.report+json');
    // An optional body does not make the group required.
    expect(result.inputSchema['required']).toBeUndefined();
  });

  it('skips an operation whose required body is multipart', () => {
    const result = mapping('upload');
    expect(result.supported).toBe(false);
    expect(codes('upload')).toContain('unsupported-request-body');
    expect(result.diagnostics[0]?.message).toContain('multipart/form-data');
  });

  it('imports an operation whose optional body is multipart, without the body', () => {
    const result = mapping('optionalUpload');
    expect(result.supported).toBe(true);
    expect(result.supported && result.inputBindings).toEqual({});
    expect(codes('optionalUpload')).toContain('unsupported-request-body');
  });

  it('skips an operation with a required header parameter', () => {
    expect(mapping('listTenants').supported).toBe(false);
    expect(codes('listTenants')).toContain('unsupported-required-parameter');
  });

  it('omits optional header and cookie parameters with a warning, and ignores Authorization', () => {
    const result = mapping('getProfile');
    expect(result.supported).toBe(true);
    expect(result.diagnostics.map((d) => d.message).join(' ')).toContain('X-Trace');
    expect(result.diagnostics.map((d) => d.message).join(' ')).toContain('session');
    // A required Authorization header is operator configuration, not an input:
    // the operation is imported rather than skipped.
    expect(result.diagnostics.map((d) => d.message).join(' ')).not.toContain('Authorization');
  });

  it('skips an operation with a required deepObject query parameter', () => {
    expect(mapping('listFilters').supported).toBe(false);
    expect(mapping('listFilters').diagnostics[0]?.message).toContain('deepObject');
  });

  it('omits an optional array query parameter it cannot serialize', () => {
    const result = mapping('listOptionalFilters');
    expect(result.supported).toBe(true);
    expect(result.supported && result.inputBindings).toEqual({});
    expect(result.diagnostics[0]?.message).toContain('not a primitive');
  });

  it('skips an operation whose {param} is never declared as a path parameter', () => {
    // The OpenAPI validator rejects this document shape, so the candidate is
    // built directly: the check exists because a `{param}` nothing can supply
    // makes every call unservable — and a paid one settles first.
    const result = mapRequest(loaded, {
      resourceId: 'legacy',
      method: 'GET',
      path: '/legacy/{id}',
      backendUrl: 'https://api.example.com/legacy/{id}',
      name: 'legacy',
      parameters: [],
      security: [],
    });
    expect(result.supported).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('undeclared-path-parameter');
  });

  it('skips a path parameter using a style the executor cannot produce', () => {
    expect(mapping('matrix').supported).toBe(false);
    expect(mapping('matrix').diagnostics[0]?.message).toContain('matrix');
  });

  it('omits a request body on a method that sends none', () => {
    const result = mapping('deleteExport');
    expect(result.supported).toBe(true);
    expect(result.supported && result.inputBindings).toEqual({});
    expect(result.diagnostics[0]?.message).toContain('not sent by the gateway');
  });

  it('reports dropped schema constraints so the summary can list them', () => {
    const constrained = mapRequest(loaded, {
      resourceId: 'x',
      method: 'POST',
      path: '/x',
      backendUrl: 'https://api.example.com/x',
      name: 'x',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { a: { type: 'string', pattern: '^a' } } },
          },
        },
      },
      security: [],
    });
    expect(constrained.supported && constrained.droppedKeywords).toEqual(['pattern']);
  });

  it('produces a shape the config loader and the pre-payment check both accept', () => {
    const result = mapping('createOrder');
    expect(result.supported).toBe(true);
    if (!result.supported) return;

    const raw = validRawConfig();
    (raw['resources'] as Record<string, unknown>) = {
      create_order: {
        name: 'Create order',
        input: result.inputSchema,
        backend: {
          type: 'http',
          method: 'POST',
          url: 'https://api.example.com/users/{userId}/orders',
          inputBindings: result.inputBindings,
        },
        pricing: { type: 'free' },
        expose: ['http'],
      },
    };
    const config = parseConfig(raw, {});
    const resource = config.resources[0];
    expect(resource?.handler.inputBindings).toEqual({ path: 'path', query: 'query', body: 'body' });
    expect(() =>
      validateBackendRequestShape(
        // biome-ignore lint/style/noNonNullAssertion: asserted above
        resource!.handler,
        { path: { userId: 'u-1' }, query: { notify: true }, body: { productId: 'abc' } },
        { requestId: 'r', resourceId: 'create_order' },
      ),
    ).not.toThrow();
  });
});
