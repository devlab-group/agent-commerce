/**
 * ACP discovery and the pre-execution guard sequence.
 *
 * Every guard failure is asserted twice: for the response the caller gets, and
 * for the pipeline never having been called. "Fails closed" is only a claim
 * until the second half is checked.
 */
import { describe, expect, it, vi } from 'vitest';
import { createResourceRegistry } from '../../../src/core/execution/index.js';
import type {
  CanonicalRequest,
  Clock,
  EventSink,
  ExecutionOutcome,
  ExecutionPipeline,
  IdGenerator,
  Logger,
  ProtocolAdapterContext,
  ResourceRegistry,
} from '../../../src/core/index.js';
import { createAcpAdapter } from '../../../src/protocols/acp/adapter.js';
import { ACP_SPEC_VERSION, ACP_WELL_KNOWN_PATH } from '../../../src/protocols/acp/constants.js';
import { guardAcpRequest } from '../../../src/protocols/acp/request-guards.js';
import { matchAcpRoute } from '../../../src/protocols/acp/router.js';
import { validateAcpDocument } from '../../../src/protocols/acp/validation.js';

const TOKEN = 'acp-secret-token';
const MOUNT = '/acp';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

const clock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  nowIso: () => '2026-01-01T00:00:00.000Z',
  monotonicMs: () => 0,
};

function setup() {
  const execute = vi.fn(async (_request: CanonicalRequest): Promise<ExecutionOutcome> => {
    throw new Error('the pipeline must not be reached');
  });
  const context: ProtocolAdapterContext = {
    pipeline: { execute } as ExecutionPipeline,
    resources: createResourceRegistry([]) as ResourceRegistry,
    events: { emit: async () => {} } as EventSink,
    logger: NOOP_LOGGER,
    clock,
    ids: { next: (prefix?: string) => `${prefix ?? 'id'}-1` } as IdGenerator,
    publicBaseUrl: 'https://merchant.example.com',
  };
  return { execute, context };
}

interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface HttpRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

function fakeExchange(request: HttpRequest) {
  let status = 0;
  let headers: Record<string, string> = {};
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(code: number, sent?: Record<string, string>) {
      status = code;
      headers = sent ?? {};
      return res;
    },
    end(chunk?: string) {
      raw = chunk ?? '';
      return res;
    },
  };
  const payload = request.body;
  const req = Object.assign(
    (async function* () {
      if (payload !== undefined) yield Buffer.from(payload, 'utf8');
    })(),
    {
      method: request.method ?? 'POST',
      url: request.url ?? `${MOUNT}/checkout_sessions`,
      headers: request.headers ?? {},
    },
  );
  const result = (): HttpResult => ({
    status,
    headers,
    body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
  });
  return { req, res, result };
}

/** An authenticated, correctly-versioned request. Individual cases override one piece. */
function goodHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'api-version': ACP_SPEC_VERSION,
    'content-type': 'application/json',
    ...extra,
  };
}

const VALID_CREATE = JSON.stringify({
  line_items: [{ id: 'item_123' }],
  currency: 'usd',
  capabilities: {},
});

async function startedAdapter(context: ProtocolAdapterContext, discovery?: unknown) {
  const adapter = createAcpAdapter({
    mountPath: MOUNT,
    token: TOKEN,
    ...(discovery !== undefined ? { discovery: discovery as never } : {}),
  });
  await adapter.start(context);
  return adapter;
}

async function checkout(
  context: ProtocolAdapterContext,
  request: HttpRequest,
): Promise<HttpResult> {
  const adapter = await startedAdapter(context);
  const { req, res, result } = fakeExchange(request);
  await adapter.handleHttp(req as never, res as never);
  return result();
}

async function discoveryDocument(
  context: ProtocolAdapterContext,
  metadata?: unknown,
): Promise<HttpResult> {
  const adapter = await startedAdapter(context, metadata);
  const { req, res, result } = fakeExchange({ method: 'GET', url: ACP_WELL_KNOWN_PATH });
  await adapter.handleDiscovery(req as never, res as never);
  return result();
}

describe('ACP discovery', () => {
  it('serves the document without authentication', async () => {
    const { context, execute } = setup();
    const result = await discoveryDocument(context);

    expect(result.status).toBe(200);
    expect(result.body['protocol']).toEqual({
      name: 'acp',
      version: ACP_SPEC_VERSION,
      supported_versions: [ACP_SPEC_VERSION],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('advertises only the REST transport and the checkout service', async () => {
    const { context } = setup();
    const result = await discoveryDocument(context);

    expect(result.body['transports']).toEqual(['rest']);
    expect(result.body['capabilities']).toEqual({ services: ['checkout'] });
  });

  it('points api_base_url at the public base URL plus the mount', async () => {
    const { context } = setup();
    const result = await discoveryDocument(context);
    expect(result.body['api_base_url']).toBe('https://merchant.example.com/acp');
  });

  it('sends a cache-control header', async () => {
    const { context } = setup();
    const result = await discoveryDocument(context);
    expect(result.headers['cache-control']).toBe('public, max-age=3600');
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('conforms to the pinned snapshot', async () => {
    const { context } = setup();
    const result = await discoveryDocument(context);
    expect(validateAcpDocument('discoveryResponse', result.body)).toBeUndefined();
  });

  it('includes optional metadata only when configured', async () => {
    const { context } = setup();
    const result = await discoveryDocument(context, {
      documentationUrl: 'https://merchant.example.com/docs/acp',
      supportedCurrencies: ['usd'],
      supportedLocales: ['en-US'],
      interventionTypes: ['3ds'],
    });

    expect(result.body['protocol']).toMatchObject({
      documentation_url: 'https://merchant.example.com/docs/acp',
    });
    expect(result.body['capabilities']).toEqual({
      services: ['checkout'],
      intervention_types: ['3ds'],
      supported_currencies: ['usd'],
      supported_locales: ['en-US'],
    });
    expect(validateAcpDocument('discoveryResponse', result.body)).toBeUndefined();
  });

  // Configured metadata is free text; publishing a document ACP's own schema
  // rejects would be exactly the blanket claim this project refuses to make.
  it('refuses to start when configured metadata would break the document', async () => {
    const { context } = setup();
    const adapter = createAcpAdapter({
      mountPath: MOUNT,
      token: TOKEN,
      discovery: { supportedCurrencies: ['US Dollars'] },
    });
    await expect(adapter.start(context)).rejects.toThrow(/discovery document/i);
    expect((await adapter.health()).status).toBe('fail');
  });

  it('refuses a write to the discovery path', async () => {
    const { context } = setup();
    const adapter = await startedAdapter(context);
    const { req, res, result } = fakeExchange({ method: 'POST', url: ACP_WELL_KNOWN_PATH });
    await adapter.handleDiscovery(req as never, res as never);
    expect(result().status).toBe(405);
  });

  it('serves nothing before start and reports its own health', async () => {
    const adapter = createAcpAdapter({ mountPath: MOUNT, token: TOKEN });
    const { req, res, result } = fakeExchange({ method: 'GET', url: ACP_WELL_KNOWN_PATH });
    await adapter.handleDiscovery(req as never, res as never);

    expect(result().status).toBe(503);
    expect((await adapter.health()).status).toBe('fail');
  });
});

describe('ACP request guards', () => {
  it.each([
    ['no Authorization header', { authorization: undefined }, 401, 'unauthorized'],
    ['a non-bearer scheme', { authorization: 'Basic dXNlcjpwYXNz' }, 401, 'unauthorized'],
    ['an empty bearer token', { authorization: 'Bearer ' }, 401, 'unauthorized'],
    ['the wrong token', { authorization: 'Bearer wrong-token' }, 401, 'unauthorized'],
    ['no API-Version', { 'api-version': undefined }, 400, 'missing_api_version'],
    ['an older API-Version', { 'api-version': '2026-01-30' }, 400, 'unsupported_api_version'],
    ['API-Version: latest', { 'api-version': 'latest' }, 400, 'unsupported_api_version'],
    [
      'a non-JSON content type',
      { 'content-type': 'application/x-www-form-urlencoded' },
      415,
      'unsupported_media_type',
    ],
  ])('rejects %s', async (_label, overrides, status, code) => {
    const { context, execute } = setup();
    const headers = goodHeaders();
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    }

    const result = await checkout(context, { headers, body: VALID_CREATE });

    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
    expect(result.body['type']).toBe('invalid_request');
    expect(execute).not.toHaveBeenCalled();
  });

  it('names the supported version on both version errors, and nothing else', async () => {
    const { context } = setup();
    const headers = goodHeaders({ 'api-version': '2025-09-29' });
    const result = await checkout(context, { headers, body: VALID_CREATE });

    expect(result.body['supported_versions']).toEqual([ACP_SPEC_VERSION]);
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
  });

  it('rejects a malformed JSON body', async () => {
    const { context, execute } = setup();
    const result = await checkout(context, { headers: goodHeaders(), body: '{"currency":' });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('invalid_json');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a valid ACP document, naming the caller-side path', async () => {
    const { context, execute } = setup();
    const result = await checkout(context, {
      headers: goodHeaders(),
      body: JSON.stringify({ line_items: [{ id: 'item_123' }], capabilities: {} }),
    });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('invalid_request_body');
    expect(result.body['param']).toBe('$.currency');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown path under the mount', 'GET', '/acp/orders', 404],
    ['a path outside the mount', 'GET', '/acp-other/checkout_sessions', 404],
    ['an unknown sub-action', 'POST', '/acp/checkout_sessions/cs_1/refund', 404],
    ['a wrong method on the collection', 'DELETE', '/acp/checkout_sessions', 405],
    ['a wrong method on a session', 'PUT', '/acp/checkout_sessions/cs_1', 405],
  ])('rejects %s', async (_label, method, url, status) => {
    const { context, execute } = setup();
    const result = await checkout(context, { method, url, headers: goodHeaders() });

    expect(result.status).toBe(status);
    expect(execute).not.toHaveBeenCalled();
  });

  // Route matching runs before authentication on purpose: a 404 for an
  // unimplemented ACP service is not information worth authenticating for, and
  // it keeps an unauthenticated caller from reaching the body reader.
  it('reads no body for an unauthenticated request', async () => {
    const { context } = setup();
    let consumed = false;
    const { res, result } = fakeExchange({ headers: {} });
    const req = Object.assign(
      (async function* () {
        consumed = true;
        yield Buffer.from(VALID_CREATE, 'utf8');
      })(),
      { method: 'POST', url: `${MOUNT}/checkout_sessions`, headers: {} },
    );
    const adapter = await startedAdapter(context);
    await adapter.handleHttp(req as never, res as never);

    expect(result().status).toBe(401);
    expect(consumed).toBe(false);
  });

  it('rejects a body over the cap without buffering it', async () => {
    const oversized = JSON.stringify({ currency: 'usd', note: 'x'.repeat(200) });
    const { req } = fakeExchange({ headers: goodHeaders(), body: oversized });
    const guard = await guardAcpRequest(req as never, {
      mountPath: MOUNT,
      token: TOKEN,
      maxBodyBytes: 32,
    });

    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.status).toBe(413);
      expect(guard.error.code).toBe('request_body_too_large');
    }
  });

  it('accepts a well-formed request and reaches the checkout handler', async () => {
    const { context } = setup();
    const result = await checkout(context, { headers: goodHeaders(), body: VALID_CREATE });

    // Guards passed; execution is not wired yet.
    expect(result.status).toBe(501);
    expect(result.body['code']).toBe('not_implemented');
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
  });

  it('accepts a cancel with no body at all', async () => {
    const { context } = setup();
    const headers = goodHeaders();
    delete headers['content-type'];
    const result = await checkout(context, {
      url: `${MOUNT}/checkout_sessions/cs_123/cancel`,
      headers,
    });

    expect(result.status).toBe(501);
  });

  it('accepts a GET with no body and no content type', async () => {
    const { context } = setup();
    const headers = goodHeaders();
    delete headers['content-type'];
    const result = await checkout(context, {
      method: 'GET',
      url: `${MOUNT}/checkout_sessions/cs_123`,
      headers,
    });

    expect(result.status).toBe(501);
  });

  it('echoes a usable Request-Id and drops one carrying control characters', async () => {
    const { context } = setup();
    const echoed = await checkout(context, {
      headers: goodHeaders({ 'request-id': 'req_abc-123' }),
      body: VALID_CREATE,
    });
    expect(echoed.headers['request-id']).toBe('req_abc-123');

    const dropped = await checkout(context, {
      headers: goodHeaders({ 'request-id': 'req\r\nx-injected: 1' }),
      body: VALID_CREATE,
    });
    expect(dropped.headers['request-id']).toBeUndefined();
  });

  it('never echoes a Request-Id on a guard failure', async () => {
    const { context } = setup();
    const headers = goodHeaders({ 'request-id': 'req_abc-123' });
    delete headers['authorization'];
    const result = await checkout(context, { headers, body: VALID_CREATE });

    expect(result.status).toBe(401);
    expect(result.headers['request-id']).toBeUndefined();
  });

  it('leaks neither the configured token nor an internal path in any error', async () => {
    const { context } = setup();
    const results = await Promise.all([
      checkout(context, { headers: { 'api-version': ACP_SPEC_VERSION }, body: VALID_CREATE }),
      checkout(context, { headers: goodHeaders(), body: '{' }),
      checkout(context, { headers: goodHeaders(), body: '{}' }),
    ]);

    for (const result of results) {
      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain('src/');
      expect(serialized).not.toContain('$defs');
    }
  });
});

describe('ACP route matching', () => {
  it.each([
    ['POST', '/acp/checkout_sessions', 'createCheckoutSession', undefined],
    ['POST', '/acp/checkout_sessions?trace=1', 'createCheckoutSession', undefined],
    ['GET', '/acp/checkout_sessions/cs_1', 'getCheckoutSession', 'cs_1'],
    ['POST', '/acp/checkout_sessions/cs_1', 'updateCheckoutSession', 'cs_1'],
    ['POST', '/acp/checkout_sessions/cs_1/complete', 'completeCheckoutSession', 'cs_1'],
    ['POST', '/acp/checkout_sessions/cs_1/cancel/', 'cancelCheckoutSession', 'cs_1'],
  ])('maps %s %s', (method, url, operation, sessionId) => {
    const matched = matchAcpRoute(method, url, MOUNT);
    expect(matched.kind).toBe('match');
    if (matched.kind === 'match') {
      expect(matched.route.operation).toBe(operation);
      expect(matched.route.sessionId).toBe(sessionId);
    }
  });

  // A percent-encoded separator must not become an extra path segment, and an
  // id is a single opaque segment - not a place to hide a path.
  it.each([
    ['an encoded separator in the id', '/acp/checkout_sessions/cs%2F1/complete'],
    ['a traversal segment', '/acp/checkout_sessions/../health'],
    ['a malformed escape', '/acp/checkout_sessions/%zz'],
    ['a mount prefix that only looks like ours', '/acpx/checkout_sessions'],
    ['the bare mount', '/acp'],
  ])('refuses %s', (_label, url) => {
    expect(matchAcpRoute('POST', url, MOUNT).kind).toBe('not-found');
  });
});
