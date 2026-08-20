import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchEvents,
  fetchReceipts,
  fetchResources,
  fetchWellKnown,
  UnauthorizedError,
} from '../src/lib/api.js';

describe('api fetch wrappers', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetchResources unwraps the { resources } envelope', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ resources: [{ id: 'r1' }] }), { status: 200 }),
    ) as typeof fetch;
    expect(await fetchResources('http://gw')).toEqual([{ id: 'r1' }]);
  });

  it('fetchWellKnown returns the document as-is', async () => {
    const doc = { merchant: { id: 'm' } };
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(doc), { status: 200 }),
    ) as typeof fetch;
    expect(await fetchWellKnown('http://gw')).toEqual(doc);
  });

  it('fetchReceipts unwraps the { receipts } envelope and passes the limit', async () => {
    let requestedUrl = '';
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    }) as typeof fetch;
    await fetchReceipts('http://gw', 7);
    expect(requestedUrl).toBe('http://gw/api/receipts?limit=7');
  });

  it('fetchEvents unwraps the { events } envelope', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ events: [{ id: 'e1' }] }), { status: 200 }),
    ) as typeof fetch;
    expect(await fetchEvents('http://gw')).toEqual([{ id: 'e1' }]);
  });

  it('throws a clear error on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(fetchResources('http://gw')).rejects.toThrow(/HTTP 503/);
  });

  ///api/receipts and /api/events sit behind the
  // gateway's admin token. A 401 must surface as an actionable, distinct
  // error rather than a bare "HTTP 401" the UI would just render verbatim.
  it('fetchReceipts throws UnauthorizedError with an actionable message on 401', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as typeof fetch;
    const err = await fetchReceipts('http://gw').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toMatch(/admin token/i);
  });

  it('fetchEvents throws UnauthorizedError with an actionable message on 401', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as typeof fetch;
    const err = await fetchEvents('http://gw').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toMatch(/VITE_ADMIN_TOKEN/);
  });
});
