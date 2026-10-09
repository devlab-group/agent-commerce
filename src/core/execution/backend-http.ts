/**
 * The built-in outbound HTTP path to a merchant backend.
 *
 * - Global `fetch`, always bounded by `AbortSignal.timeout`.
 * - `redirect: 'manual'`: a 3xx response is a `BACKEND_ERROR`, never followed
 *   (SSRF hardening).
 * - `{param}` segments in `handler.url` are filled from validated input and
 *   URL-encoded; the rest is mapped as `BackendHandler.inputBindings`
 *   describes (see `backend-request.ts`).
 */
import { type BackendHandler, DEFAULT_BACKEND_TIMEOUT_MS } from '../domain/resource';
import { CommerceError, isCommerceError } from '../errors';
import type { BackendExecutor, BackendRequest, BackendResponse } from '../interfaces/backend';
import { type Logger, NOOP_LOGGER } from '../interfaces/logger';
import { isRecord } from '../is-record';
import {
  buildBackendRequestParts,
  buildHeaders,
  checkQueryCollision,
  setHeader,
  stringifyPrimitive,
} from './backend-request';

const MAX_BODY_SNIPPET_LENGTH = 512;

// How a merchant recognizes a repeat of an operation. The de facto standard
// name, and the one ACP requires inbound.
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

// The timeout bounds a response by time, not bytes; this stops a hostile or
// broken backend from filling memory
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface HttpBackendExecutorOptions {
  /** Override for `fetch`, used in tests. Defaults to the global implementation */
  readonly fetchImpl?: typeof fetch;
  /** Receives a non-2xx backend body at debug level; it never reaches the client */
  readonly logger?: Logger;
}

/**
 * Merchant non-2xx response attached as the `BACKEND_ERROR` cause. Adapters
 * can inspect its body and headers; client errors omit the cause.
 */
export class BackendErrorResponse {
  constructor(
    readonly status: number,
    readonly body: unknown,
    /** Lowercase names, as `Headers` yields them */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {}
}

export class HttpBackendExecutor implements BackendExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(options: HttpBackendExecutorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async call(handler: BackendHandler, request: BackendRequest): Promise<BackendResponse> {
    const timeoutMs = handler.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
    const inputRecord = isRecord(request.input) ? request.input : {};

    const context = { requestId: request.requestId, resourceId: request.resourceId };
    // Throws INPUT_INVALID for every shape problem. The pipeline already ran it
    // before payment through validateBackendRequestShape(); this copy covers a
    // caller that bypasses the pipeline.
    const parts = buildBackendRequestParts(handler, inputRecord, context);

    let target: URL;
    try {
      target = new URL(parts.url);
    } catch (error) {
      throw new CommerceError('BACKEND_ERROR', 'Backend URL could not be constructed from input', {
        ...context,
        details: { reason: 'invalid-url' },
        cause: error,
      });
    }

    // Beyond the per-parameter check: the resolved path must stay under the
    // template's literal prefix (everything before the first `{`)
    const prefixPathname = literalPrefixPathname(handler);
    if (prefixPathname !== undefined && !target.pathname.startsWith(prefixPathname)) {
      throw new CommerceError(
        'INPUT_INVALID',
        'Path parameters resolved outside the configured backend path',
        context,
      );
    }

    const headers = buildHeaders(handler, context, request.backendHeaders);
    // Replaces a configured header of the same name, unlike content-type below:
    // a static key would make every request look like a retry of the first
    if (request.idempotencyKey !== undefined) {
      setHeader(headers, IDEMPOTENCY_KEY_HEADER, request.idempotencyKey, context);
    }
    let body: string | undefined;

    // searchParams.set() replaces an existing param, so a caller key named
    // like an operator's query param (`?apikey=SECRET` in handler.url) would
    // overwrite it. validateBackendRequestShape() runs the same check before
    // payment.
    checkQueryCollision(target, parts.query, context);
    for (const [key, value] of Object.entries(parts.query)) {
      target.searchParams.set(key, stringifyPrimitive(value));
    }
    if (parts.body !== undefined) {
      body = JSON.stringify(parts.body.value);
      // A configured Content-Type, such as `application/vnd.x+json`, wins
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    const started = performance.now();
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: handler.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      if (isAbortError(error)) {
        throw new CommerceError(
          'BACKEND_TIMEOUT',
          `Backend request timed out after ${timeoutMs}ms`,
          {
            requestId: request.requestId,
            resourceId: request.resourceId,
            details: { timeoutMs, durationMs },
            cause: error,
          },
        );
      }
      throw new CommerceError('BACKEND_ERROR', 'Backend request failed (transport error)', {
        requestId: request.requestId,
        resourceId: request.resourceId,
        details: { durationMs },
        cause: error,
      });
    }
    const durationMs = Math.round(performance.now() - started);

    const isRedirect =
      response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
    if (isRedirect) {
      throw new CommerceError(
        'BACKEND_ERROR',
        'Backend responded with a redirect, which is not followed',
        {
          requestId: request.requestId,
          resourceId: request.resourceId,
          details: { status: response.status, reason: 'redirect-not-followed' },
        },
      );
    }

    const responseHeaders = Object.fromEntries(response.headers);
    const contentType = response.headers.get('content-type') ?? '';
    let parsedBody: unknown;
    try {
      parsedBody = await parseBody(response, contentType);
    } catch (error) {
      const tooLarge = isCommerceError(error);
      throw new CommerceError(
        'BACKEND_ERROR',
        tooLarge
          ? 'Backend response exceeded the maximum allowed size'
          : 'Backend response could not be read',
        {
          requestId: request.requestId,
          resourceId: request.resourceId,
          details: tooLarge
            ? { reason: 'response-too-large', maxBytes: MAX_RESPONSE_BODY_BYTES }
            : { reason: 'read-error' },
          cause: error,
        },
      );
    }

    if (response.status < 200 || response.status >= 300) {
      // The status may reach the client, but the body is logged at debug level
      // only: a backend in verbose error mode emits stack traces, hostnames or
      // SQL fragments, and the caller may be anonymous
      this.logger.debug(
        {
          requestId: request.requestId,
          resourceId: request.resourceId,
          status: response.status,
          bodySnippet: truncateSnippet(parsedBody),
        },
        'Backend responded with a non-2xx status',
      );
      throw new CommerceError('BACKEND_ERROR', `Backend responded with status ${response.status}`, {
        requestId: request.requestId,
        resourceId: request.resourceId,
        details: { status: response.status },
        cause: new BackendErrorResponse(response.status, parsedBody, responseHeaders),
      });
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: parsedBody,
      durationMs,
    };
  }
}

// `handler.url` never changes, so its literal prefix is parsed once per handler.
// `null` records a prefix that is not a URL, as when a parameter sits in the
// host (which config refuses); the containment check is then skipped.
const prefixPathnames = new WeakMap<BackendHandler, string | null>();

function literalPrefixPathname(handler: BackendHandler): string | undefined {
  let cached = prefixPathnames.get(handler);
  if (cached === undefined) {
    try {
      cached = new URL(handler.url.split('{')[0] ?? handler.url).pathname;
    } catch {
      cached = null;
    }
    prefixPathnames.set(handler, cached);
  }
  return cached ?? undefined;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        // The only CommerceError parseBody can throw, which is how its caller
        // tells an oversized body from a read failure
        throw new CommerceError('BACKEND_ERROR', `response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseBody(response: Response, contentType: string): Promise<unknown> {
  const text = await readBodyCapped(response, MAX_RESPONSE_BODY_BYTES);
  if (text.length === 0) return text;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function truncateSnippet(body: unknown): string {
  const text = typeof body === 'string' ? body : safeStringify(body);
  return text.length > MAX_BODY_SNIPPET_LENGTH
    ? `${text.slice(0, MAX_BODY_SNIPPET_LENGTH)}…`
    : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
