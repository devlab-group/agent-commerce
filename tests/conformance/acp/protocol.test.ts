/**
 * Discovery and the request-level protocol rules, over a real socket.
 *
 * Every rejection here is asserted twice: the response the client gets, and the
 * merchant never having been called. A guard that answers correctly but lets
 * the request through anyway is not a guard.
 */
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAcpDocument } from '../../../src/protocols/acp/validation';
import {
  ACP_TOKEN,
  type AcpStack,
  acpFetch,
  acpHeaders,
  COMPLETE_REQUEST,
  CREATE_REQUEST,
  startAcpStack,
} from './support/gateway';

let stack: AcpStack;

// The request target is sent exactly as given, and the status is returned
function rawRequest(method: string, path: string, body?: unknown): Promise<number> {
  const target = new URL(stack.url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: target.hostname, port: target.port, method, path, headers: acpHeaders() },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

beforeEach(async () => {
  stack = await startAcpStack();
});

afterEach(async () => {
  await stack.close();
});

describe('discovery', () => {
  it('is served unauthenticated at the specification-fixed path', async () => {
    const response = await fetch(`${stack.url}/.well-known/acp.json`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(validateAcpDocument('discoveryResponse', body)).toBeUndefined();
  });

  it('advertises exactly what this deployment implements', async () => {
    const body = (await (await fetch(`${stack.url}/.well-known/acp.json`)).json()) as Record<
      string,
      unknown
    >;

    expect(body['protocol']).toEqual({
      name: 'acp',
      version: '2026-04-17',
      supported_versions: ['2026-04-17'],
    });
    expect(body['transports']).toEqual(['rest']);
    expect(body['capabilities']).toEqual({ services: ['checkout'] });
  });

  it('publishes no credential and no internal detail', async () => {
    const text = await (await fetch(`${stack.url}/.well-known/acp.json`)).text();

    expect(text).not.toContain(ACP_TOKEN);
    expect(text).not.toContain('acp_checkout_');
    expect(text).not.toContain('idempotency');
  });
});

describe('request guards', () => {
  async function post(headers: Record<string, string>) {
    return acpFetch(stack, '/acp/checkout_sessions', { headers, body: CREATE_REQUEST });
  }

  function without(header: string): Record<string, string> {
    const headers = acpHeaders();
    delete headers[header];
    return headers;
  }

  it.each([
    ['missing Authorization', () => without('authorization'), 401, 'unauthorized'],
    [
      'the wrong bearer token',
      () => acpHeaders({ authorization: 'Bearer not-the-token' }),
      401,
      'unauthorized',
    ],
    ['missing API-Version', () => without('api-version'), 400, 'missing_api_version'],
    [
      'an older API-Version',
      () => acpHeaders({ 'api-version': '2026-01-30' }),
      400,
      'unsupported_api_version',
    ],
    [
      'a newer API-Version',
      () => acpHeaders({ 'api-version': '2026-12-01' }),
      400,
      'unsupported_api_version',
    ],
    [
      'the unreleased upstream spec',
      () => acpHeaders({ 'api-version': 'unreleased' }),
      400,
      'unsupported_api_version',
    ],
    ['missing Idempotency-Key', () => without('idempotency-key'), 400, 'idempotency_key_required'],
    [
      'an Idempotency-Key over 255 characters',
      () => acpHeaders({ 'idempotency-key': 'k'.repeat(256) }),
      400,
      'idempotency_key_invalid',
    ],
    [
      'a non-JSON content type',
      () => acpHeaders({ 'content-type': 'text/plain' }),
      415,
      'unsupported_media_type',
    ],
  ])('rejects %s without calling the merchant', async (_label, headers, status, code) => {
    const result = await post(headers());

    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
    expect(stack.calls).toEqual([]);
  });

  // The positive control for every "without calling the merchant" case here
  it('reaches the merchant exactly once when every guard holds', async () => {
    const result = await post(acpHeaders());

    expect(result.status).toBe(201);
    expect(stack.calls).toHaveLength(1);
  });

  it('names the supported version on a version rejection', async () => {
    const result = await post(acpHeaders({ 'api-version': 'latest' }));
    expect(result.body['supported_versions']).toEqual(['2026-04-17']);
  });

  it.each([
    ['malformed JSON', '{"currency":', 'invalid_json'],
    [
      'a document the snapshot rejects',
      JSON.stringify({ currency: 'usd' }),
      'invalid_request_body',
    ],
  ])('rejects %s without calling the merchant', async (_label, payload, code) => {
    const response = await fetch(`${stack.url}/acp/checkout_sessions`, {
      method: 'POST',
      headers: acpHeaders(),
      body: payload,
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body['code']).toBe(code);
    expect(stack.calls).toEqual([]);
  });

  // The router accepts "." and ".." as opaque ids; the backend request builder
  // refuses them as path values before the merchant is called. `fetch`
  // resolves dot segments before sending, so these go over a raw socket. The
  // real id is the positive control.
  it.each([
    ['POST', '/acp/checkout_sessions/../complete', 400, 0],
    ['POST', '/acp/checkout_sessions/%2E%2E/complete', 400, 0],
    ['GET', '/acp/checkout_sessions/.', 400, 0],
    ['POST', '/acp/checkout_sessions/cs_1/complete', 200, 1],
  ])(
    'forwards %s %s to the merchant only if the session id is not a dot segment',
    async (method, path, status, calls) => {
      const sent = await rawRequest(method, path, method === 'POST' ? COMPLETE_REQUEST : undefined);

      expect(sent).toBe(status);
      expect(stack.calls).toHaveLength(calls);
    },
  );

  it('answers 404 for a path ACP does not define, and 405 for the wrong method', async () => {
    const unknown = await acpFetch(stack, '/acp/orders', { method: 'GET' });
    const wrongMethod = await acpFetch(stack, '/acp/checkout_sessions', { method: 'DELETE' });

    expect(unknown.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(stack.calls).toEqual([]);
  });
});

describe('response headers', () => {
  it('echoes Request-Id and Idempotency-Key, and no merchant header', async () => {
    const result = await acpFetch(stack, '/acp/checkout_sessions', {
      headers: acpHeaders({ 'idempotency-key': 'idem-headers-1', 'request-id': 'req-abc' }),
      body: CREATE_REQUEST,
    });

    expect(result.headers.get('request-id')).toBe('req-abc');
    expect(result.headers.get('idempotency-key')).toBe('idem-headers-1');
    expect(result.headers.get('idempotent-replayed')).toBeNull();
    expect(result.headers.get('set-cookie')).toBeNull();
  });

  it('drops a Request-Id that is not printable ASCII', async () => {
    // `fetch` refuses a literal CRLF outright (that case is covered by the
    // unit tests); this is a value it will send and the adapter must not echo
    const result = await acpFetch(stack, '/acp/checkout_sessions', {
      headers: acpHeaders({ 'request-id': 'req-\u00e9' }),
      body: CREATE_REQUEST,
    });

    expect(result.status).toBe(201);
    expect(result.headers.get('request-id')).toBeNull();
  });
});

describe('request headers passed on to the merchant', () => {
  it('forwards the six seller-facing headers and never the bearer token', async () => {
    const sent = {
      'accept-language': 'de-DE',
      'user-agent': 'conformance-agent/1.0',
      'request-id': 'req-forward-1',
      signature: 'c2lnbmF0dXJl',
      timestamp: '2026-10-05T10:00:00Z',
    };
    const result = await acpFetch(stack, '/acp/checkout_sessions', {
      headers: acpHeaders(sent),
      body: CREATE_REQUEST,
    });

    expect(result.status).toBe(201);
    const received = stack.calls[0]?.headers ?? {};
    expect(received).toMatchObject({ ...sent, 'api-version': '2026-04-17' });
    expect(received['authorization']).toBeUndefined();
    expect(JSON.stringify(received)).not.toContain(ACP_TOKEN);
    // The merchant gets the derived operation key, not the caller's own
    expect(received['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forwards them on a GET as well', async () => {
    await acpFetch(stack, '/acp/checkout_sessions/cs_abc123', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${ACP_TOKEN}`,
        'api-version': '2026-04-17',
        'accept-language': 'fr-FR',
      },
    });

    expect(stack.calls[0]?.headers['accept-language']).toBe('fr-FR');
    expect(stack.calls[0]?.headers['authorization']).toBeUndefined();
  });
});
