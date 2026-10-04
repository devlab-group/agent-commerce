import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAccessControlHook,
  buildOperatorTokenHook,
} from '../../../src/gateway/access-control';

// Records each timingSafeEqual call, so a test can show the admin token is
// compared in constant time; a plain `===` makes the same decisions
const comparisons = vi.hoisted(() => ({ byteLengths: [] as number[][] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      comparisons.byteLengths.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

function fakeReply(): FastifyReply & {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const reply = {
    headers,
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    header(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload?: unknown) {
      reply.body = payload;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & typeof reply;
}

function fakeRequest(overrides: {
  method?: string;
  url?: string;
  host?: string;
  origin?: string;
  authorization?: string;
}): FastifyRequest {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/health',
    headers: {
      host: overrides.host ?? 'localhost',
      ...(overrides.origin !== undefined ? { origin: overrides.origin } : {}),
      ...(overrides.authorization !== undefined ? { authorization: overrides.authorization } : {}),
    },
  } as unknown as FastifyRequest;
}

const BASE = { publicBaseUrl: 'http://localhost:8080', allowedOrigins: [] as string[] };

describe('buildAccessControlHook (Host and CORS only)', () => {
  it('passes a plain request with no Origin and a matching Host', async () => {
    const hook = buildAccessControlHook(BASE);
    const reply = fakeReply();
    await hook(fakeRequest({ host: 'localhost' }), reply);
    expect(reply.statusCode).toBeUndefined();
  });

  it('rejects a Host that is neither publicBaseUrl nor a loopback alias', async () => {
    const hook = buildAccessControlHook(BASE);
    const reply = fakeReply();
    await hook(fakeRequest({ host: 'attacker.example' }), reply);
    expect(reply.statusCode).toBe(403);
  });

  it('rejects a Host that only contains or extends an allowed name', async () => {
    // A rebinding page controls its own hostname, including public names that
    // resolve to 127.0.0.1, so only an exact match may pass
    const hook = buildAccessControlHook({ ...BASE, publicBaseUrl: 'https://shop.example.com' });
    for (const host of [
      'shop.example.com.attacker.net',
      'evil-shop.example.com',
      'localhost.attacker.example',
      '127.0.0.1.nip.io',
    ]) {
      const reply = fakeReply();
      await hook(fakeRequest({ host }), reply);
      expect(reply.statusCode, host).toBe(403);
    }
    const control = fakeReply();
    await hook(fakeRequest({ host: 'shop.example.com' }), control);
    expect(control.statusCode).toBeUndefined();
  });

  it('accepts every loopback alias regardless of publicBaseUrl', async () => {
    const hook = buildAccessControlHook(BASE);
    for (const host of ['127.0.0.1:9999', 'localhost:1', '[::1]:2']) {
      const reply = fakeReply();
      await hook(fakeRequest({ host }), reply);
      expect(reply.statusCode).toBeUndefined();
    }
  });

  it('rejects a request with no Host header at all', async () => {
    const hook = buildAccessControlHook(BASE);
    const reply = fakeReply();
    const req = fakeRequest({ host: 'localhost' });
    delete (req.headers as Record<string, unknown>)['host'];
    await hook(req, reply);
    expect(reply.statusCode).toBe(403);
  });

  it('rejects an Origin not on the allowlist', async () => {
    const hook = buildAccessControlHook(BASE);
    const reply = fakeReply();
    await hook(fakeRequest({ origin: 'https://evil.example' }), reply);
    expect(reply.statusCode).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets CORS headers for an allowlisted Origin and lets the request through', async () => {
    const hook = buildAccessControlHook({ ...BASE, allowedOrigins: ['https://dash.example'] });
    const reply = fakeReply();
    await hook(fakeRequest({ origin: 'https://dash.example' }), reply);
    expect(reply.statusCode).toBeUndefined();
    expect(reply.headers['access-control-allow-origin']).toBe('https://dash.example');
    expect(reply.headers['vary']).toBe('Origin');
    // No gateway surface serves DELETE, so a preflight must not advertise it
    expect(reply.headers['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
    // Browser requests for payment, authorization and protocol calls need
    // these headers on the preflight allowlist
    const allowed = String(reply.headers['access-control-allow-headers']).split(',');
    expect(allowed).toEqual(
      expect.arrayContaining([
        'payment-signature',
        'agent-authorization',
        'authorization',
        'mcp-protocol-version',
        'mcp-method',
        'mcp-name',
        'a2a-version',
        'a2a-extensions',
        'api-version',
        'idempotency-key',
        'request-id',
      ]),
    );
    // Browser code can read only the response headers named here: the
    // challenge, the settlement result and ACP's echoed headers
    const exposed = String(reply.headers['access-control-expose-headers']).split(',');
    expect(exposed).toEqual(
      expect.arrayContaining([
        'payment-required',
        'payment-response',
        'www-authenticate',
        'payment-receipt',
        'idempotency-key',
        'request-id',
        'idempotent-replayed',
        'retry-after',
      ]),
    );
  });

  it('short-circuits an OPTIONS preflight for an allowlisted Origin with 204', async () => {
    const hook = buildAccessControlHook({ ...BASE, allowedOrigins: ['https://dash.example'] });
    const reply = fakeReply();
    await hook(fakeRequest({ method: 'OPTIONS', origin: 'https://dash.example' }), reply);
    expect(reply.statusCode).toBe(204);
  });

  it('compares Origin against the allowlist case-insensitively, echoing the browser-supplied casing back', async () => {
    const hook = buildAccessControlHook({ ...BASE, allowedOrigins: ['https://Dash.Example'] });
    const reply = fakeReply();
    await hook(fakeRequest({ origin: 'https://dash.example' }), reply);
    expect(reply.statusCode).toBeUndefined();
    expect(reply.headers['access-control-allow-origin']).toBe('https://dash.example');
  });

  it('sends no CORS header at all when the request carries no Origin (agent/MCP traffic)', async () => {
    const hook = buildAccessControlHook(BASE);
    const reply = fakeReply();
    await hook(fakeRequest({}), reply);
    expect(reply.statusCode).toBeUndefined();
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('buildOperatorTokenHook (unit, fakes)', () => {
  it('404s with no adminToken configured', async () => {
    const hook = buildOperatorTokenHook(undefined);
    const reply = fakeReply();
    await hook(fakeRequest({ url: '/api/receipts' }), reply);
    expect(reply.statusCode).toBe(404);
  });

  it('401s with a missing or wrong token once one is configured', async () => {
    const hook = buildOperatorTokenHook('right');
    const missing = fakeReply();
    await hook(fakeRequest({ url: '/api/events' }), missing);
    expect(missing.statusCode).toBe(401);

    const wrong = fakeReply();
    await hook(fakeRequest({ url: '/api/events', authorization: 'Bearer wrong' }), wrong);
    expect(wrong.statusCode).toBe(401);
  });

  it('lets the request through with the correct Bearer token', async () => {
    const hook = buildOperatorTokenHook('right');
    const reply = fakeReply();
    await hook(fakeRequest({ url: '/api/receipts', authorization: 'Bearer right' }), reply);
    expect(reply.statusCode).toBeUndefined();
  });

  it('matches the Bearer scheme case-insensitively (RFC 7235) but still needs the token', async () => {
    const hook = buildOperatorTokenHook('right');
    for (const authorization of ['bearer right', 'BEARER right', 'Bearer  right']) {
      const reply = fakeReply();
      await hook(fakeRequest({ url: '/api/receipts', authorization }), reply);
      expect(reply.statusCode, authorization).toBeUndefined();
    }
    for (const authorization of [
      'Bearer ',
      'Basic right',
      'right',
      // Prefix, extension and case variants of the token itself
      'Bearer righ',
      'Bearer rightt',
      'Bearer RIGHT',
    ]) {
      const reply = fakeReply();
      await hook(fakeRequest({ url: '/api/receipts', authorization }), reply);
      expect(reply.statusCode, authorization).toBe(401);
    }
  });

  it('compares the token in constant time over fixed-length digests, whatever length is presented', async () => {
    const hook = buildOperatorTokenHook('right');
    comparisons.byteLengths.length = 0;
    for (const token of ['wrong', 'x'.repeat(500), 'right']) {
      await hook(
        fakeRequest({ url: '/api/receipts', authorization: `Bearer ${token}` }),
        fakeReply(),
      );
    }
    expect(comparisons.byteLengths).toEqual([
      [32, 32],
      [32, 32],
      [32, 32],
    ]);
  });

  it('does not accept the admin token as a query parameter on any route', async () => {
    for (const url of ['/api/receipts?adminToken=right', '/api/events?adminToken=right']) {
      const hook = buildOperatorTokenHook('right');
      const reply = fakeReply();
      await hook(fakeRequest({ url }), reply);
      expect(reply.statusCode, url).toBe(401);
    }
  });
});

describe('regression: percent-encoded path cannot bypass the token gate', () => {
  // Through `.inject()`, so the real router runs: it decodes a path before
  // matching, which a test of the hook function alone cannot see
  function buildTestServer(adminToken: string | undefined) {
    const server = Fastify({ logger: false });
    server.get('/api/receipts', { onRequest: buildOperatorTokenHook(adminToken) }, async () => ({
      receipts: [],
    }));
    server.get('/api/events', { onRequest: buildOperatorTokenHook(adminToken) }, async () => ({
      events: [],
    }));
    return server;
  }

  const ENCODED_PATHS = ['/api/%72eceipts', '/api/%65vents'];

  it('a percent-encoded path still requires the token (token configured)', async () => {
    const server = buildTestServer('right');
    for (const url of ENCODED_PATHS) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} should require auth`).toBe(401);
    }
    for (const url of ENCODED_PATHS) {
      const authed = await server.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer right' },
      });
      expect(authed.statusCode, `${url} should succeed with the right token`).toBe(200);
    }
    await server.close();
  });

  it('a percent-encoded path still 404s fail-closed (no token configured)', async () => {
    const server = buildTestServer(undefined);
    for (const url of ENCODED_PATHS) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} should 404`).toBe(404);
    }
    await server.close();
  });

  it('double-encoded and malformed-escape paths do not bypass the gate either', async () => {
    const server = buildTestServer('right');

    // %2572 decodes once, to the literal "%72", so the router matches no route
    const double = await server.inject({ method: 'GET', url: '/api/%2572eceipts' });
    expect(double.statusCode).toBe(404);

    // A malformed escape (%zz): the router rejects it before any route matches
    const malformed = await server.inject({ method: 'GET', url: '/api/%zzeceipts' });
    expect(malformed.statusCode).toBe(400);

    await server.close();
  });
});
