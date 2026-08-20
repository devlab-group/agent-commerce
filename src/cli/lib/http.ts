/**
 * Small fetch-with-timeout helper for `doctor`. Injectable so tests never hit
 * a real network — they point it at a local stub HTTP server instead.
 */
export type FetchLike = typeof fetch;

export interface FetchJsonResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: T;
  readonly error?: string;
}

export async function fetchJson<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs = 1500,
): Promise<FetchJsonResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    let body: T | undefined;
    try {
      body = (await res.json()) as T;
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, ...(body !== undefined ? { body } : {}) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'unknown fetch error',
    };
  } finally {
    clearTimeout(timer);
  }
}
