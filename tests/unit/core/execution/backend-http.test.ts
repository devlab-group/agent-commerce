import { describe, expect, it, vi } from 'vitest';
import type { BackendHandler } from '../../../../src/core/domain/resource';
import { isCommerceError } from '../../../../src/core/errors';
import {
  HttpBackendExecutor,
  validateBackendRequestShape,
} from '../../../../src/core/execution/backend-http';
import { NOOP_LOGGER } from '../../../../src/core/interfaces/logger';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const shapeContext = { requestId: 'r', resourceId: 'res' };

function expectInputInvalid(run: () => void): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(isCommerceError(error) && error.code === 'INPUT_INVALID').toBe(true);
  }
}

describe('HttpBackendExecutor', () => {
  it('performs path templating and sends remaining input as query params for GET', async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = new URL(input as URL);
      return jsonResponse(200, { ok: true });
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/weather/{city}',
    };
    const result = await executor.call(handler, {
      requestId: 'req-1',
      resourceId: 'weather',
      input: { city: 'Berlin', unit: 'celsius' },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(capturedUrl?.pathname).toBe('/api/weather/Berlin');
    expect(capturedUrl?.searchParams.get('unit')).toBe('celsius');
    expect(capturedUrl?.searchParams.get('city')).toBeNull();
  });

  it('forwards an idempotency key to the merchant as Idempotency-Key', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(201, { created: true });
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const handler: BackendHandler = {
      type: 'http',
      method: 'POST',
      url: 'http://backend.local/api/orders',
    };
    await executor.call(handler, {
      requestId: 'req-1',
      resourceId: 'orders',
      input: { sku: 'abc' },
      idempotencyKey: 'op-key-1',
    });

    expect(capturedHeaders['idempotency-key']).toBe('op-key-1');
  });

  it('sends no Idempotency-Key when the protocol has no notion of one', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(200, { ok: true });
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await executor.call(
      { type: 'http', method: 'GET', url: 'http://backend.local/api/weather' },
      { requestId: 'req-1', resourceId: 'weather', input: {} },
    );

    expect(capturedHeaders['idempotency-key']).toBeUndefined();
  });

  it('replaces a statically configured idempotency header, whatever its casing', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(201, { created: true });
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const handler: BackendHandler = {
      type: 'http',
      method: 'POST',
      url: 'http://backend.local/api/orders',
      headers: { 'Idempotency-Key': 'baked-in-and-never-changing' },
    };
    await executor.call(handler, {
      requestId: 'req-1',
      resourceId: 'orders',
      input: { sku: 'abc' },
      idempotencyKey: 'op-key-1',
    });

    // A fixed key would make every order after the first look like a retry of
    // the first, so the per-operation value wins rather than deferring to config
    expect(capturedHeaders['idempotency-key']).toBe('op-key-1');
  });

  it('refuses an idempotency key that would inject a header line, without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, {}));
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      executor.call(
        { type: 'http', method: 'POST', url: 'http://backend.local/api/orders' },
        {
          requestId: 'r',
          resourceId: 'res',
          input: {},
          idempotencyKey: 'op-key-1\r\nx-injected: 1',
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        error.code === 'BACKEND_ERROR' &&
        JSON.stringify(error.details) === JSON.stringify({ reason: 'invalid-header' }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends remaining input as a JSON body for POST', async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(201, { created: true });
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const handler: BackendHandler = {
      type: 'http',
      method: 'POST',
      url: 'http://backend.local/api/orders',
    };
    const result = await executor.call(handler, {
      requestId: 'req-2',
      resourceId: 'orders',
      input: { item: 'widget' },
    });

    expect(result.status).toBe(201);
    expect(JSON.parse(capturedBody ?? '{}')).toEqual({ item: 'widget' });
    expect(capturedHeaders['content-type']).toBe('application/json');
  });

  it('passes through configured headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
      headers: { 'x-api-key': 'secret-value' },
    };
    await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });

    expect(capturedHeaders['x-api-key']).toBe('secret-value');
  });

  it('refuses an illegal configured header as BACKEND_ERROR without quoting its value', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
      headers: { 'x-api-key': 'secret\nvalue' },
    };
    const context = { requestId: 'r', resourceId: 'res' };

    for (const attempt of [
      () => executor.call(handler, { ...context, input: {} }),
      async () => validateBackendRequestShape(handler, {}, context),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isCommerceError(error) && error.code).toBe('BACKEND_ERROR');
      expect(isCommerceError(error) && error.details).toEqual({ reason: 'invalid-header' });
      expect(JSON.stringify(error)).not.toContain('secret');
      expect((error as Error).cause).toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws BACKEND_TIMEOUT on abort', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new DOMException('The operation was aborted', 'TimeoutError');
      throw error;
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
      timeoutMs: 5,
    };
    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_TIMEOUT',
    );
  });

  it('never ships the backend response body to the client; only logs it (debug) and states the status', async () => {
    const bigBody = 'x'.repeat(1000);
    const fetchImpl = vi.fn(
      async () => new Response(bigBody, { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const debugCalls: Array<Record<string, unknown>> = [];
    const logger = {
      ...NOOP_LOGGER,
      debug: (obj: Record<string, unknown>) => debugCalls.push(obj),
    };
    const executor = new HttpBackendExecutor({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });

    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    const promise = executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
    await expect(promise).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_ERROR',
    );
    try {
      await promise;
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.details).toEqual({ status: 500 });
        expect(error.details).not.toHaveProperty('bodySnippet');
      }
    }
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0]?.['bodySnippet']).toBe(`${bigBody.slice(0, 512)}…`);
  });

  it('throws BACKEND_ERROR on transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_ERROR',
    );
  });

  it('does not follow redirects: a 3xx is a BACKEND_ERROR', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location: 'http://evil.example/' } }),
    );
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };

    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        error.code === 'BACKEND_ERROR' &&
        JSON.stringify(error.details) ===
          JSON.stringify({ status: 302, reason: 'redirect-not-followed' }),
    );

    const call = fetchImpl.mock.calls[0];
    expect(call?.[1]?.redirect).toBe('manual');
  });

  it('refuses a 4xx answer as BACKEND_ERROR, never as a delivery', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'no such report' }));
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      executor.call(
        { type: 'http', method: 'GET', url: 'http://backend.local/api' },
        { requestId: 'r', resourceId: 'res', input: {} },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        error.code === 'BACKEND_ERROR' &&
        JSON.stringify(error.details) === JSON.stringify({ status: 404 }),
    );
  });

  it('aborts a backend that does not answer within handler.timeoutMs', async () => {
    // Settles only when the executor's own signal fires
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      executor.call(
        { type: 'http', method: 'GET', url: 'http://backend.local/api', timeoutMs: 20 },
        { requestId: 'r', resourceId: 'res', input: {} },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        error.code === 'BACKEND_TIMEOUT' &&
        error.details?.['timeoutMs'] === 20,
    );
  });

  it('parses non-JSON content types as text', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('plain text body', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    const result = await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
    expect(result.body).toBe('plain text body');
  });

  it('throws INPUT_INVALID (not BACKEND_ERROR) when a path parameter is missing from input', async () => {
    // INPUT_INVALID is what validateBackendRequestShape raises before payment;
    // this covers call()'s own copy of the check
    const fetchImpl = vi.fn();
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/{city}',
    };

    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses DELETE with query params, and does not override an explicit content-type header on POST', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = new URL(input as URL);
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const deleteHandler: BackendHandler = {
      type: 'http',
      method: 'DELETE',
      url: 'http://backend.local/api',
    };
    await executor.call(deleteHandler, { requestId: 'r', resourceId: 'res', input: { id: '42' } });
    expect(capturedUrl?.searchParams.get('id')).toBe('42');

    const postHandler: BackendHandler = {
      type: 'http',
      method: 'POST',
      url: 'http://backend.local/api',
      headers: { 'Content-Type': 'application/vnd.custom+json' },
    };
    await executor.call(postHandler, { requestId: 'r', resourceId: 'res', input: {} });
    expect(capturedHeaders['content-type']).toBe('application/vnd.custom+json');
  });

  it('falls back to raw text when the body claims JSON but is not valid JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('not-json{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    const result = await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
    expect(result.body).toBe('not-json{{');
  });

  it('handles an empty response body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    const result = await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
    expect(result.status).toBe(204);
    expect(result.body).toBe('');
  });

  it('JSON-stringifies a non-primitive query value', async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = new URL(input as URL);
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    await executor.call(handler, {
      requestId: 'r',
      resourceId: 'res',
      input: { filter: { nested: true } },
    });
    expect(capturedUrl?.searchParams.get('filter')).toBe('{"nested":true}');
  });

  it('truncates the logged JSON error body snippet to at most 512 characters', async () => {
    const bigObject = { items: Array.from({ length: 200 }, (_, i) => `item-${i}`) };
    const fetchImpl = vi.fn(async () => jsonResponse(500, bigObject));
    const debugCalls: Array<Record<string, unknown>> = [];
    const logger = {
      ...NOOP_LOGGER,
      debug: (obj: Record<string, unknown>) => debugCalls.push(obj),
    };
    const executor = new HttpBackendExecutor({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    try {
      await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
      expect.unreachable();
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.details).not.toHaveProperty('bodySnippet');
      }
    }
    const snippet = debugCalls[0]?.['bodySnippet'];
    expect(typeof snippet).toBe('string');
    expect((snippet as string).length).toBeLessThanOrEqual(513);
  });

  it('recognizes AbortError (not only TimeoutError) as a timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_TIMEOUT',
    );
  });

  it('applies the default timeout when handler.timeoutMs is not set', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a caller input key colliding with a query param already baked into backend.url', async () => {
    const fetchImpl = vi.fn();
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/report?apikey=SECRET',
    };
    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: { apikey: 'attacker' } }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not let a non-colliding input key touch an existing query param (control)', async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = new URL(input as URL);
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/report?apikey=SECRET',
    };
    await executor.call(handler, { requestId: 'r', resourceId: 'res', input: { city: 'paris' } });
    expect(capturedUrl?.searchParams.get('apikey')).toBe('SECRET');
    expect(capturedUrl?.searchParams.get('city')).toBe('paris');
  });

  it('rejects a ".." path-parameter value rather than letting the URL normalize it away', async () => {
    const fetchImpl = vi.fn();
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/weather/{city}',
    };
    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: { city: '..' } }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects "." and empty-string path-parameter values too', async () => {
    const fetchImpl = vi.fn();
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/weather/{city}',
    };
    for (const bad of ['.', '']) {
      await expect(
        executor.call(handler, { requestId: 'r', resourceId: 'res', input: { city: bad } }),
      ).rejects.toSatisfy(
        (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a legitimate value containing a literal dot is untouched (control)', async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = new URL(input as URL);
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/weather/{city}',
    };
    await executor.call(handler, {
      requestId: 'r',
      resourceId: 'res',
      input: { city: 'st. louis' },
    });
    expect(capturedUrl?.pathname).toBe('/api/weather/st.%20louis');
  });

  it('percent-encodes a path value so it stays one segment of the configured path', async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = new URL(input as URL);
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await executor.call(
      { type: 'http', method: 'GET', url: 'http://backend.local/api/weather/{city}' },
      { requestId: 'r', resourceId: 'res', input: { city: '../admin?token=1#x' } },
    );

    expect(capturedUrl?.pathname).toBe('/api/weather/..%2Fadmin%3Ftoken%3D1%23x');
    expect(capturedUrl?.search).toBe('');
    expect(capturedUrl?.hash).toBe('');
  });

  it('refuses a filled-in path that resolves outside the literal prefix of the template', async () => {
    // Each value passes the per-parameter check, but this template ends in a
    // partial escape: "e" completes "%2e%2e", which the URL parser resolves
    // as ".."
    const fetchImpl = vi.fn();
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/v1/%2e%2{suffix}',
    };

    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: { suffix: 'e' } }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'INPUT_INVALID',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads a path parameter named like an Object.prototype member only from the input itself', () => {
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/{constructor}',
    };
    expectInputInvalid(() => validateBackendRequestShape(handler, {}, shapeContext));
    expect(() =>
      validateBackendRequestShape(handler, { constructor: 'x' }, shapeContext),
    ).not.toThrow();
  });

  it('rejects a backend response larger than the 1MB cap with BACKEND_ERROR', async () => {
    const bigBody = 'x'.repeat(2 * 1024 * 1024); // 2MB, well over the cap
    const fetchImpl = vi.fn(
      async () =>
        new Response(bigBody, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} }),
    ).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_ERROR',
    );
  });

  it('refuses one byte over the cap and surfaces the limit in the client-visible details', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('x'.repeat(1024 * 1024 + 1), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    await expect(
      executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        JSON.stringify(error.details) ===
          JSON.stringify({ reason: 'response-too-large', maxBytes: 1024 * 1024 }),
    );
  });

  it('accepts a response of exactly the cap (control)', async () => {
    const body = 'x'.repeat(1024 * 1024);
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    const result = await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
    expect(result.body).toBe(body);
  });

  it('validateBackendRequestShape rejects traversal path values without any I/O', () => {
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/{city}',
    };
    expectInputInvalid(() => validateBackendRequestShape(handler, { city: '..' }, shapeContext));
  });

  it('validateBackendRequestShape rejects a MISSING path parameter, not just an invalid one', () => {
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/{city}',
    };
    try {
      validateBackendRequestShape(handler, {}, { requestId: 'r', resourceId: 'res' });
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error) && error.code === 'INPUT_INVALID').toBe(true);
    }
  });

  it('validateBackendRequestShape rejects a query-param collision without any I/O', () => {
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api?apikey=SECRET',
    };
    try {
      validateBackendRequestShape(
        handler,
        { apikey: 'attacker' },
        { requestId: 'r', resourceId: 'res' },
      );
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error) && error.code === 'INPUT_INVALID').toBe(true);
    }
  });

  it('validateBackendRequestShape passes valid input through without throwing (control)', () => {
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/{city}',
    };
    expect(() =>
      validateBackendRequestShape(
        handler,
        { city: 'Berlin' },
        { requestId: 'r', resourceId: 'res' },
      ),
    ).not.toThrow();
  });
});

describe('HttpBackendExecutor explicit inputBindings', () => {
  function capturingExecutor(): {
    executor: HttpBackendExecutor;
    seen: { url?: URL; body?: string; headers: Record<string, string> };
  } {
    const seen: { url?: URL; body?: string; headers: Record<string, string> } = { headers: {} };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.url = new URL(input as URL);
      const rawBody = init?.body as string | undefined;
      if (rawBody !== undefined) seen.body = rawBody;
      seen.headers = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(200, { ok: true });
    });
    return {
      executor: new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      seen,
    };
  }

  const postHandler: BackendHandler = {
    type: 'http',
    method: 'POST',
    url: 'http://backend.local/users/{userId}/orders',
    inputBindings: { path: 'path', query: 'query', body: 'body' },
  };

  it('sources path, query and body independently on one POST', async () => {
    const { executor, seen } = capturingExecutor();
    await executor.call(postHandler, {
      requestId: 'r',
      resourceId: 'res',
      input: {
        path: { userId: 'u-1' },
        query: { notify: true },
        body: { productId: 'abc', quantity: 2 },
      },
    });

    expect(seen.url?.pathname).toBe('/users/u-1/orders');
    expect(seen.url?.searchParams.get('notify')).toBe('true');
    expect(JSON.parse(seen.body as string)).toEqual({ productId: 'abc', quantity: 2 });
    expect(seen.headers['content-type']).toBe('application/json');
  });

  it('does not forward top-level input that no binding names', async () => {
    const { executor, seen } = capturingExecutor();
    await executor.call(postHandler, {
      requestId: 'r',
      resourceId: 'res',
      input: {
        path: { userId: 'u-1' },
        body: { productId: 'abc' },
        // deliberately unmapped: an adapter- or agent-supplied extra
        payment: 'base64-proof',
        apiKey: 'leaked',
      },
    });

    expect(seen.url?.search).toBe('');
    expect(JSON.parse(seen.body as string)).toEqual({ productId: 'abc' });
  });

  it('sends path + query with no body when the body binding resolves to nothing', async () => {
    const { executor, seen } = capturingExecutor();
    await executor.call(postHandler, {
      requestId: 'r',
      resourceId: 'res',
      input: { path: { userId: 'u-1' }, query: { notify: false } },
    });

    expect(seen.url?.searchParams.get('notify')).toBe('false');
    expect(seen.body).toBeUndefined();
    expect(seen.headers['content-type']).toBeUndefined();
  });

  it('keeps a configured Content-Type authoritative for an explicit body', async () => {
    const { executor, seen } = capturingExecutor();
    await executor.call(
      { ...postHandler, headers: { 'Content-Type': 'application/vnd.merchant+json' } },
      {
        requestId: 'r',
        resourceId: 'res',
        input: { path: { userId: 'u-1' }, body: { productId: 'abc' } },
      },
    );

    expect(seen.headers['content-type']).toBe('application/vnd.merchant+json');
  });

  it('appends mapped query parameters on a GET and sends no body', async () => {
    const { executor, seen } = capturingExecutor();
    await executor.call(
      {
        type: 'http',
        method: 'GET',
        url: 'http://backend.local/users/{userId}',
        inputBindings: { path: 'path', query: 'query', body: 'body' },
      },
      {
        requestId: 'r',
        resourceId: 'res',
        input: { path: { userId: 'u-1' }, query: { verbose: 1 }, body: { ignored: true } },
      },
    );

    expect(seen.url?.pathname).toBe('/users/u-1');
    expect(seen.url?.searchParams.get('verbose')).toBe('1');
    expect(seen.body).toBeUndefined();
  });

  it('rejects a mapped query collision with backend.url before payment', () => {
    expectInputInvalid(() =>
      validateBackendRequestShape(
        {
          type: 'http',
          method: 'POST',
          url: 'http://backend.local/orders?apikey=SECRET',
          inputBindings: { query: 'query', body: 'body' },
        },
        { query: { apikey: 'attacker' }, body: {} },
        shapeContext,
      ),
    );
  });

  it('rejects a missing path group before payment', () => {
    expectInputInvalid(() =>
      validateBackendRequestShape(postHandler, { body: { productId: 'abc' } }, shapeContext),
    );
  });

  it('rejects a non-object path group before payment', () => {
    expectInputInvalid(() =>
      validateBackendRequestShape(postHandler, { path: 'u-1' }, shapeContext),
    );
  });

  it('rejects a non-object query group before payment', () => {
    expectInputInvalid(() =>
      validateBackendRequestShape(
        postHandler,
        { path: { userId: 'u-1' }, query: 'notify=true' },
        shapeContext,
      ),
    );
  });

  it('rejects a traversal path value inside the bound group before payment', () => {
    expectInputInvalid(() =>
      validateBackendRequestShape(postHandler, { path: { userId: '..' } }, shapeContext),
    );
  });

  it('passes a valid path + query + body shape (control)', () => {
    expect(() =>
      validateBackendRequestShape(
        postHandler,
        { path: { userId: 'u-1' }, query: { notify: true }, body: { productId: 'abc' } },
        shapeContext,
      ),
    ).not.toThrow();
  });
});

describe('HttpBackendExecutor - forwarded headers', () => {
  const handler: BackendHandler = {
    type: 'http',
    method: 'POST',
    url: 'http://backend.local/api/orders',
    headers: { 'X-Api-Key': 'operator-key', 'User-Agent': 'operator-agent' },
  };

  async function sent(
    backendHeaders: Record<string, string>,
    target: BackendHandler = handler,
  ): Promise<Record<string, string>> {
    let captured: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      captured = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(200, {});
    });
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await executor.call(target, {
      requestId: 'r',
      resourceId: 'res',
      input: { sku: 'abc' },
      idempotencyKey: 'derived-key',
      backendHeaders,
    });
    return captured;
  }

  it('sends a forwarded header the operator did not configure', async () => {
    const headers = await sent({ 'accept-language': 'en-US', signature: 'c2ln' });

    expect(headers['accept-language']).toBe('en-US');
    expect(headers['signature']).toBe('c2ln');
    expect(headers['x-api-key']).toBe('operator-key');
  });

  it('keeps a configured header over a forwarded one, whatever its casing', async () => {
    const headers = await sent({ 'x-api-key': 'caller-key', 'USER-AGENT': 'caller-agent' });

    expect(headers['x-api-key']).toBe('operator-key');
    expect(headers['user-agent']).toBe('operator-agent');
  });

  it('keeps the derived Idempotency-Key and its own content-type', async () => {
    const headers = await sent({ 'idempotency-key': 'caller-key', 'content-type': 'text/plain' });

    expect(headers['idempotency-key']).toBe('derived-key');
    expect(headers['content-type']).toBe('application/json');
  });

  it.each([
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'host',
    'content-length',
    'connection',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'proxy-authorization',
    'proxy-connection',
  ])('never forwards %s', async (name) => {
    const headers = await sent(
      { [name]: 'caller-value' },
      { type: 'http', method: 'POST', url: 'http://backend.local/api/orders' },
    );

    expect(JSON.stringify(headers)).not.toContain('caller-value');
  });

  it.each([
    ['an illegal value', { 'accept-language': 'en\r\nx-injected: 1' }],
    ['an illegal name', { 'bad name': 'v' }],
  ])('refuses %s as INPUT_INVALID before any I/O, without quoting it', async (_label, bad) => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    for (const attempt of [
      () => executor.call(handler, { ...shapeContext, input: {}, backendHeaders: bad }),
      async () => validateBackendRequestShape(handler, {}, shapeContext, bad),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isCommerceError(error) && error.code).toBe('INPUT_INVALID');
      expect(JSON.stringify(error)).not.toContain('x-injected');
      expect((error as Error).cause).toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attaches the response headers of a non-2xx answer to the error cause', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}, { 'Retry-After': '7' }));
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await executor.call(handler, { ...shapeContext, input: {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const cause = (error as Error).cause as { headers?: Record<string, string> };
    expect(cause.headers?.['retry-after']).toBe('7');
  });
});
