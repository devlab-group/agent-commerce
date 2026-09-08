/**
 * Discovery and the request-level protocol rules, over a real socket.
 *
 * Every rejection here is asserted twice: the response the client gets, and the
 * merchant never having been called. A guard that answers correctly but lets
 * the request through anyway is not a guard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACP_SPEC_VERSION } from '../../../src/protocols/acp/constants.js';
import { validateAcpDocument } from '../../../src/protocols/acp/validation.js';
import {
  ACP_TOKEN,
  type AcpStack,
  acpFetch,
  acpHeaders,
  CREATE_REQUEST,
  startAcpStack,
} from './support/gateway.js';

let stack: AcpStack;

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
      version: ACP_SPEC_VERSION,
      supported_versions: [ACP_SPEC_VERSION],
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

  it('names the supported version on a version rejection', async () => {
    const result = await post(acpHeaders({ 'api-version': 'latest' }));
    expect(result.body['supported_versions']).toEqual([ACP_SPEC_VERSION]);
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
    // unit tests); this is a value it will send and the adapter must not echo.
    const result = await acpFetch(stack, '/acp/checkout_sessions', {
      headers: acpHeaders({ 'request-id': 'req-\u00e9' }),
      body: CREATE_REQUEST,
    });

    expect(result.status).toBe(201);
    expect(result.headers.get('request-id')).toBeNull();
  });
});
