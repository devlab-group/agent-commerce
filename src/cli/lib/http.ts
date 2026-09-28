/**
 * Fetch with a timeout, for `doctor`. `fetchImpl` is injected so tests can
 * pass a fake `fetch` and never touch the network.
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
  try {
    // The signal also bounds the body read below
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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
  }
}
