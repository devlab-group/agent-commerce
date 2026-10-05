/**
 * ACP discovery and the pre-execution guard sequence.
 *
 * Every guard failure is asserted twice: for the response the caller gets, and
 * for the pipeline never having been called. "Fails closed" is only a claim
 * until the second half is checked.
 */
import { describe, expect, it } from 'vitest';
import type { ProtocolAdapterContext } from '../../../src/core';
import { createAcpAdapter } from '../../../src/protocols/acp/adapter';
import { ACP_SPEC_VERSION, ACP_WELL_KNOWN_PATH } from '../../../src/protocols/acp/constants';
import { guardAcpRequest } from '../../../src/protocols/acp/request-guards';
import { matchAcpRoute } from '../../../src/protocols/acp/router';
import { validateAcpDocument } from '../../../src/protocols/acp/validation';
import { createBearerCheck } from '../../../src/protocols/http';
import { adapterOptions, deliveredFor, firstRequest, MOUNT, setup, TOKEN } from './fixtures';

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

// An authenticated, correctly-versioned request. Individual cases override one piece
function goodHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'api-version': ACP_SPEC_VERSION,
    'content-type': 'application/json',
    'idempotency-key': 'idem-key-1',
    ...extra,
  };
}

const VALID_CREATE = JSON.stringify({
  line_items: [{ id: 'item_123' }],
  currency: 'usd',
  capabilities: {},
});

async function startedAdapter(context: ProtocolAdapterContext, discovery?: unknown) {
  const adapter = createAcpAdapter(
    adapterOptions(discovery !== undefined ? { discovery: discovery as never } : {}),
  );
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

  // Configured metadata is free text, so a document ACP's own schema rejects
  // is never published
  it('refuses to start when configured metadata would break the document', async () => {
    const { context } = setup();
    const adapter = createAcpAdapter(
      adapterOptions({ discovery: { supportedCurrencies: ['US Dollars'] } }),
    );
    await expect(adapter.start(context)).rejects.toThrow(/discovery document/i);
    expect((await adapter.health()).status).toBe('fail');
  });

  it('refuses a write to the discovery path', async () => {
    const { context } = setup();
    const adapter = await startedAdapter(context);
    const { req, res, result } = fakeExchange({ method: 'POST', url: ACP_WELL_KNOWN_PATH });
    await adapter.handleDiscovery(req as never, res as never);
    expect(result().status).toBe(405);
    expect(result().headers['allow']).toBe('GET');
  });

  it('serves nothing before start and reports its own health', async () => {
    const adapter = createAcpAdapter(adapterOptions());
    const { req, res, result } = fakeExchange({ method: 'GET', url: ACP_WELL_KNOWN_PATH });
    await adapter.handleDiscovery(req as never, res as never);

    expect(result().status).toBe(503);
    expect((await adapter.health()).status).toBe('fail');
  });
});

describe('ACP request guards', () => {
  it.each([
    ['no Authorization header', { authorization: undefined }, 401, 'unauthorized'],
    // The right token under another scheme, so only the scheme check can refuse it
    ['a non-bearer scheme', { authorization: `Basic ${TOKEN}` }, 401, 'unauthorized'],
    ['an empty bearer token', { authorization: 'Bearer ' }, 401, 'unauthorized'],
    ['the wrong token', { authorization: 'Bearer wrong-token' }, 401, 'unauthorized'],
    [
      'a Signature header in place of a bearer token',
      { authorization: undefined, signature: 'sig1=:c2lnbmF0dXJl:', timestamp: '1767225600' },
      401,
      'unauthorized',
    ],
    ['no API-Version', { 'api-version': undefined }, 400, 'missing_api_version'],
    ['an older API-Version', { 'api-version': '2026-01-30' }, 400, 'unsupported_api_version'],
    ['API-Version: latest', { 'api-version': 'latest' }, 400, 'unsupported_api_version'],
    ['no Idempotency-Key', { 'idempotency-key': undefined }, 400, 'idempotency_key_required'],
    ['a blank Idempotency-Key', { 'idempotency-key': '   ' }, 400, 'idempotency_key_required'],
    [
      'an over-long Idempotency-Key',
      { 'idempotency-key': 'k'.repeat(256) },
      400,
      'idempotency_key_invalid',
    ],
    [
      'an Idempotency-Key with a newline',
      { 'idempotency-key': 'k\r\nx: 1' },
      400,
      'idempotency_key_invalid',
    ],
    [
      'a non-JSON content type',
      { 'content-type': 'application/x-www-form-urlencoded' },
      415,
      'unsupported_media_type',
    ],
    [
      'a JSON body with no content type',
      { 'content-type': undefined },
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

  it.each([
    ['a missing', undefined],
    ['an unsupported', '2025-09-29'],
  ])('names the supported version on %s API-Version, and nothing else', async (_label, version) => {
    const { context } = setup();
    const headers = goodHeaders();
    if (version === undefined) delete headers['api-version'];
    else headers['api-version'] = version;
    const result = await checkout(context, { headers, body: VALID_CREATE });

    expect(result.status).toBe(400);
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
    // RFC 9110 requires Allow on a 405
    if (status === 405) expect(result.headers['allow']).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // Route matching runs before authentication on purpose: a 404 for an
  // unimplemented ACP service is not information worth authenticating for.
  // Authentication still runs before the body reader, which is what this
  // checks. The valid token is the positive control: it shows the reader does
  // consume this stream once authentication passes.
  it.each([
    ['no Authorization header', undefined, 401, false],
    ['a non-bearer scheme', `Basic ${TOKEN}`, 401, false],
    ['an empty bearer token', 'Bearer ', 401, false],
    ['the wrong token', 'Bearer wrong-token', 401, false],
    ['the valid token', `Bearer ${TOKEN}`, 201, true],
  ])(
    'reads the body only after authentication: %s',
    async (_label, authorization, status, read) => {
      const { context } = setup(deliveredFor('createCheckoutSession'));
      let consumed = false;
      const { res, result } = fakeExchange({});
      const headers = goodHeaders();
      if (authorization === undefined) delete headers['authorization'];
      else headers['authorization'] = authorization;
      const req = Object.assign(
        (async function* () {
          consumed = true;
          yield Buffer.from(VALID_CREATE, 'utf8');
        })(),
        { method: 'POST', url: `${MOUNT}/checkout_sessions`, headers },
      );
      const adapter = await startedAdapter(context);
      await adapter.handleHttp(req as never, res as never);

      expect(result().status).toBe(status);
      expect(consumed).toBe(read);
    },
  );

  it('stops reading a body at the cap instead of buffering the rest', async () => {
    let pulled = 0;
    const req = Object.assign(
      (async function* () {
        for (let chunk = 0; chunk < 10; chunk += 1) {
          pulled += 1;
          yield Buffer.alloc(16, 0x20);
        }
      })(),
      { method: 'POST', url: `${MOUNT}/checkout_sessions`, headers: goodHeaders() },
    );
    const guard = await guardAcpRequest(req as never, {
      mountPath: MOUNT,
      isAuthorized: createBearerCheck(TOKEN),
      maxBodyBytes: 32,
    });

    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.status).toBe(413);
      expect(guard.error.code).toBe('request_body_too_large');
    }
    // The third 16-byte chunk crosses the 32-byte cap; nothing after it is pulled
    expect(pulled).toBe(3);
  });

  it('accepts a well-formed request and executes it exactly once', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const result = await checkout(context, { headers: goodHeaders(), body: VALID_CREATE });

    expect(result.status).toBe(201);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts an Idempotency-Key of exactly 255 characters', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const result = await checkout(context, {
      headers: goodHeaders({ 'idempotency-key': 'k'.repeat(255) }),
      body: VALID_CREATE,
    });

    expect(result.status).toBe(201);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts a cancel with no body at all', async () => {
    const { context, execute } = setup(deliveredFor('cancelCheckoutSession'));
    const headers = goodHeaders();
    delete headers['content-type'];
    const result = await checkout(context, {
      url: `${MOUNT}/checkout_sessions/cs_123/cancel`,
      headers,
    });

    expect(result.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts a GET with no body and no content type', async () => {
    const { context, execute } = setup(deliveredFor('getCheckoutSession'));
    const headers = goodHeaders();
    delete headers['content-type'];
    const result = await checkout(context, {
      method: 'GET',
      url: `${MOUNT}/checkout_sessions/cs_123`,
      headers,
    });

    expect(result.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('echoes a usable Request-Id, truncated, and drops one carrying control characters', async () => {
    const { context } = setup(deliveredFor('createCheckoutSession'));
    const echoed = await checkout(context, {
      headers: goodHeaders({ 'request-id': 'req_abc-123' }),
      body: VALID_CREATE,
    });
    expect(echoed.headers['request-id']).toBe('req_abc-123');

    const truncated = await checkout(context, {
      headers: goodHeaders({ 'request-id': 'r'.repeat(300) }),
      body: VALID_CREATE,
    });
    expect(truncated.headers['request-id']).toBe('r'.repeat(128));

    const dropped = await checkout(context, {
      headers: goodHeaders({ 'request-id': 'req\r\nx-injected: 1' }),
      body: VALID_CREATE,
    });
    expect(dropped.status).toBe(201);
    expect(dropped.headers['request-id']).toBeUndefined();
  });

  it('echoes safe request and idempotency ids on POST refusals', async () => {
    const { context } = setup();
    const headers = goodHeaders({ 'request-id': 'req_abc-123' });
    delete headers['authorization'];
    const unauthorized = await checkout(context, { headers, body: VALID_CREATE });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['request-id']).toBe('req_abc-123');
    expect(unauthorized.headers['idempotency-key']).toBe(goodHeaders()['idempotency-key']);
    expect(unauthorized.headers['www-authenticate']).toBe('Bearer');

    for (const version of [undefined, '2025-09-29']) {
      const versionHeaders = goodHeaders();
      delete versionHeaders['api-version'];
      if (version !== undefined) versionHeaders['api-version'] = version;
      const refused = await checkout(context, { headers: versionHeaders, body: VALID_CREATE });
      expect(refused.status).toBe(400);
      expect(refused.headers['idempotency-key']).toBe(goodHeaders()['idempotency-key']);
    }

    // A key that fails its own syntax check is never written into a response
    const badKey = goodHeaders({ 'idempotency-key': 'k'.repeat(256) });
    delete badKey['authorization'];
    const unechoed = await checkout(context, { headers: badKey, body: VALID_CREATE });
    expect(unechoed.status).toBe(401);
    expect(unechoed.headers['idempotency-key']).toBeUndefined();

    const invalidBody = await checkout(context, {
      headers: goodHeaders({ 'request-id': 'req_abc-123' }),
      body: '{',
    });
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.headers['request-id']).toBe('req_abc-123');
    expect(invalidBody.headers['idempotency-key']).toBe(goodHeaders()['idempotency-key']);
  });

  it('echoes the ids on the 503 before start and on an unexpected 500', async () => {
    const headers = goodHeaders({ 'request-id': 'req_abc-123' });

    // Shutdown stops adapters before the server, so this 503 is reachable
    const stopped = createAcpAdapter(adapterOptions());
    const before = fakeExchange({ headers, body: VALID_CREATE });
    await stopped.handleHttp(before.req as never, before.res as never);
    expect(before.result().status).toBe(503);
    expect(before.result().headers['request-id']).toBe('req_abc-123');
    expect(before.result().headers['idempotency-key']).toBe(headers['idempotency-key']);

    const { context } = setup();
    const broken: ProtocolAdapterContext = {
      ...context,
      ids: {
        next: () => {
          throw new Error('id source failed');
        },
      },
    };
    const failed = await checkout(broken, { headers, body: VALID_CREATE });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ code: 'internal_error' });
    expect(failed.headers['request-id']).toBe('req_abc-123');
    expect(failed.headers['idempotency-key']).toBe(headers['idempotency-key']);
  });

  it('forwards only the six allowed caller headers', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const result = await checkout(context, {
      headers: goodHeaders({
        'accept-language': 'en-US',
        'user-agent': 'agent/1.0',
        'request-id': 'req_abc-123',
        signature: 'c2ln',
        timestamp: '2026-10-05T10:00:00Z',
        cookie: 'session=1',
        'x-api-key': 'caller-key',
      }),
      body: VALID_CREATE,
    });

    expect(result.status).toBe(201);
    // No Authorization, Idempotency-Key, Content-Type or unlisted header
    expect(firstRequest(execute).backendHeaders).toEqual({
      'accept-language': 'en-US',
      'user-agent': 'agent/1.0',
      'request-id': 'req_abc-123',
      'api-version': ACP_SPEC_VERSION,
      signature: 'c2ln',
      timestamp: '2026-10-05T10:00:00Z',
    });
  });

  it('drops invalid forwarded header values without failing', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const result = await checkout(context, {
      headers: goodHeaders({
        signature: 's'.repeat(2049),
        'user-agent': 'agent\r\nx-injected: 1',
        'accept-language': 'en\u00e9',
        timestamp: '2026-10-05T10:00:00Z',
      }),
      body: VALID_CREATE,
    });

    expect(result.status).toBe(201);
    expect(firstRequest(execute).backendHeaders).toEqual({
      'api-version': ACP_SPEC_VERSION,
      timestamp: '2026-10-05T10:00:00Z',
    });
  });

  it('drops a Request-Id that is not printable ASCII, even on a guard failure', async () => {
    const { context } = setup();
    const headers = goodHeaders({ 'request-id': 'req\u00e9' });
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
  // `path` scopes idempotency keys, so a query string, a trailing slash or an
  // escaped spelling of the same endpoint must not yield a second scope
  it.each([
    [
      'POST',
      '/acp/checkout_sessions',
      'createCheckoutSession',
      undefined,
      '/acp/checkout_sessions',
    ],
    [
      'POST',
      '/acp/checkout_sessions?trace=1',
      'createCheckoutSession',
      undefined,
      '/acp/checkout_sessions',
    ],
    [
      'GET',
      '/acp/checkout_sessions/cs_1',
      'getCheckoutSession',
      'cs_1',
      '/acp/checkout_sessions/cs_1',
    ],
    [
      'POST',
      '/acp/checkout_sessions/cs_1',
      'updateCheckoutSession',
      'cs_1',
      '/acp/checkout_sessions/cs_1',
    ],
    [
      'POST',
      '/acp/checkout_sessions/cs%5F1/complete',
      'completeCheckoutSession',
      'cs_1',
      '/acp/checkout_sessions/cs_1/complete',
    ],
    [
      'POST',
      '/acp/checkout_sessions/cs_1/cancel/',
      'cancelCheckoutSession',
      'cs_1',
      '/acp/checkout_sessions/cs_1/cancel',
    ],
  ])('maps %s %s', (method, url, operation, sessionId, path) => {
    const matched = matchAcpRoute(method, url, MOUNT);
    expect(matched.kind).toBe('match');
    if (matched.kind === 'match') {
      expect(matched.route.operation).toBe(operation);
      expect(matched.route.sessionId).toBe(sessionId);
      expect(matched.route.path).toBe(path);
    }
  });

  // Encoded separators stay inside the session id and remain encoded in the
  // canonical endpoint path used for idempotency.
  it.each([
    [
      'an encoded separator in the id',
      '/acp/checkout_sessions/cs%2F1/complete',
      'completeCheckoutSession',
      'cs/1',
      '/acp/checkout_sessions/cs%2F1/complete',
    ],
    [
      'an encoded separator that only looks like an action',
      '/acp/checkout_sessions/cs_1%2Fcomplete',
      'updateCheckoutSession',
      'cs_1/complete',
      '/acp/checkout_sessions/cs_1%2Fcomplete',
    ],
    [
      'a global id',
      '/acp/checkout_sessions/gid%3A%2F%2Fshop%2FCheckout%2F1',
      'updateCheckoutSession',
      'gid://shop/Checkout/1',
      '/acp/checkout_sessions/gid%3A%2F%2Fshop%2FCheckout%2F1',
    ],
    [
      'an id with a space',
      '/acp/checkout_sessions/cs%201',
      'updateCheckoutSession',
      'cs 1',
      '/acp/checkout_sessions/cs%201',
    ],
  ])('routes %s as one session id', (_label, url, operation, sessionId, path) => {
    const matched = matchAcpRoute('POST', url, MOUNT);
    expect(matched).toMatchObject({ kind: 'match', route: { operation, sessionId, path } });
  });

  it.each([
    ['a control character in the id', '/acp/checkout_sessions/cs%001/complete'],
    ['a malformed escape', '/acp/checkout_sessions/%zz'],
    ['a mount prefix that only looks like ours', '/acpx/checkout_sessions'],
    ['the bare mount', '/acp'],
  ])('refuses %s', (_label, url) => {
    expect(matchAcpRoute('POST', url, MOUNT).kind).toBe('not-found');
  });
});
