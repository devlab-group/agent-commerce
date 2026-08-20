import { describe, expect, it, vi } from 'vitest';
import type { BackendHandler } from '../../../../src/core/domain/resource.js';
import { isCommerceError } from '../../../../src/core/errors/index.js';
import {
  HttpBackendExecutor,
  validateBackendRequestShape,
} from '../../../../src/core/execution/backend-http.js';
import { NOOP_LOGGER } from '../../../../src/core/interfaces/logger.js';

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
    expect(debugCalls[0]?.['bodySnippet']).toBe(bigBody.slice(0, 512) + '…');
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
      (error: unknown) => isCommerceError(error) && error.code === 'BACKEND_ERROR',
    );

    const call = fetchImpl.mock.calls[0];
    expect(call?.[1]?.redirect).toBe('manual');
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
    // As BACKEND_ERROR this surfaces only after verify -> reserve -> settle,
    // so a paid resource whose {param} nothing can supply would charge the
    // buyer on every call. INPUT_INVALID lets
    // validateBackendRequestShape (which the pipeline calls before payment)
    // catch it first; this test covers call()'s own defence-in-depth copy.
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

  it('recognises AbortError (not only TimeoutError) as a timeout', async () => {
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

  it('rejects a ".." path-parameter value rather than letting the URL normalise it away', async () => {
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

  it('surfaces the byte limit itself in the client-visible details', async () => {
    const bigBody = 'x'.repeat(2 * 1024 * 1024);
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
    try {
      await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
      expect.unreachable();
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.details).toEqual({ reason: 'response-too-large', maxBytes: 1024 * 1024 });
      }
    }
  });

  it('accepts a response right at/under the cap (control)', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(1000) });
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: 'x'.repeat(1000) }));
    const executor = new HttpBackendExecutor({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api',
    };
    const result = await executor.call(handler, { requestId: 'r', resourceId: 'res', input: {} });
    expect((result.body as { data: string }).data).toBe(JSON.parse(body).data);
  });

  it('validateBackendRequestShape rejects traversal path values without any I/O ', () => {
    const handler: BackendHandler = {
      type: 'http',
      method: 'GET',
      url: 'http://backend.local/api/{city}',
    };
    expect(() =>
      validateBackendRequestShape(handler, { city: '..' }, { requestId: 'r', resourceId: 'res' }),
    ).toThrowError();
    try {
      validateBackendRequestShape(handler, { city: '..' }, { requestId: 'r', resourceId: 'res' });
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error) && error.code === 'INPUT_INVALID').toBe(true);
    }
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

  it('validateBackendRequestShape rejects a query-param collision without any I/O ', () => {
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
