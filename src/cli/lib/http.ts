import { gotNoAnswer } from '../../core/no-answer';

/**
 * Fetch with a timeout, for `doctor`. `fetchImpl` is injected so tests can
 * pass a fake `fetch` and never touch the network.
 */
export type FetchLike = typeof fetch;

export interface FetchJsonResult<T> {
  readonly ok: boolean;
  /** The HTTP status, or 0 when the request threw */
  readonly status: number;
  readonly body?: T;
  readonly error?: string;
  /** Present when `gotNoAnswer` recognizes a transport failure */
  readonly noAnswer?: true;
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
      error: errorText(err),
      ...(gotNoAnswer(err) ? { noAnswer: true as const } : {}),
    };
  }
}

// Include a nested cause's message to explain undici's generic "fetch failed"
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown fetch error';
  let root = err;
  for (let depth = 0; depth < 10 && root.cause instanceof Error; depth++) root = root.cause;
  return root === err ? err.message : `${err.message}: ${root.message}`;
}
