/**
 * The built-in outbound HTTP path to a merchant backend.
 *
 * - Global `fetch`, always bounded by `AbortSignal.timeout`.
 * - `redirect: 'manual'`: a 3xx response is a `BACKEND_ERROR`, never followed
 *   (SSRF hardening).
 * - `{param}` segments in `handler.url` are filled from validated input and
 *   URL-encoded; the rest is mapped as `BackendHandler.inputBindings`
 *   describes.
 */
import {
  type BackendHandler,
  type BackendMethod,
  DEFAULT_BACKEND_TIMEOUT_MS,
} from '../domain/resource';
import { CommerceError, isCommerceError } from '../errors';
import type { BackendExecutor, BackendRequest, BackendResponse } from '../interfaces/backend';
import { type Logger, NOOP_LOGGER } from '../interfaces/logger';
import { isRecord } from '../is-record';

const MAX_BODY_SNIPPET_LENGTH = 512;
// How a merchant recognizes a repeat of an operation. The de facto standard
// name, and the one ACP requires inbound.
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
// The one `{param}` grammar, shared by substitution, config, `doctor` and the
// OpenAPI importer. It admits `-` and `.` because
// `/report/{report-id}` is ordinary REST. Config refuses any other brace
// (findUnparsedBraceToken).
const PATH_PARAM_PATTERN = /\{([a-zA-Z0-9_.-]+)\}/g;
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
 * A merchant's non-2xx response, attached to `BACKEND_ERROR` as its cause.
 * An adapter can inspect the body when its protocol defines an error format.
 * `CommerceError.toInfo()` omits the cause from client responses; the backend
 * executor logs a truncated body snippet at debug level.
 */
export class BackendErrorResponse {
  constructor(
    readonly status: number,
    readonly body: unknown,
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

    const headers = buildHeaders(handler, context);
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
        cause: new BackendErrorResponse(response.status, parsedBody),
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

/**
 * `{param}` names in a `backend.url` template, in declaration order. Config,
 * `doctor` and the OpenAPI importer use it so they read the same grammar as
 * substitution.
 */
export function extractPathParameterNames(url: string): string[] {
  return [...url.matchAll(PATH_PARAM_PATTERN)].map((match) => match[1] as string);
}

/**
 * A brace left over after every legal `{param}` is removed, or `undefined`.
 *
 * `{report id}`, `{a/b}`, `{}` and an unbalanced `{` match no parameter and
 * would reach the backend as literals, which on a paid resource means payment
 * without delivery. Config refuses any such residue, and the OpenAPI importer
 * skips the operation.
 */
export function findUnparsedBraceToken(url: string): string | undefined {
  const residue = url.replace(PATH_PARAM_PATTERN, '');
  const index = residue.search(/[{}]/);
  if (index === -1) return undefined;
  // Report the offending run, not just the character, so the error is fixable
  const token = /\{[^{}]*\}?|\}/.exec(residue.slice(index));
  return token?.[0] ?? residue[index];
}

/**
 * Runs the traversal, query-collision and header checks that `call()` repeats,
 * so the pipeline can run them after schema validation and before pricing.
 * Schema validation cannot catch these: `inputSchema` knows nothing about the
 * URL template. Found only inside `call()`, after settlement, a bad value such
 * as `{ city: "" }` for a paid, path-templated resource would take payment
 * without delivery. Throws INPUT_INVALID for the input, BACKEND_ERROR for an
 * illegal configured header, and does no I/O.
 */
export function validateBackendRequestShape(
  handler: BackendHandler,
  input: unknown,
  context: ShapeContext,
): void {
  const inputRecord = isRecord(input) ? input : {};

  // Every shape error (missing or invalid path parameter, a bound group that is
  // not an object) throws INPUT_INVALID here
  const parts = buildBackendRequestParts(handler, inputRecord, context);
  // Config refuses a bad header at load; this covers a hand-built resource
  buildHeaders(handler, context);

  let target: URL;
  try {
    target = new URL(parts.url);
  } catch {
    return; // call() raises BACKEND_ERROR for an unparseable URL
  }
  checkQueryCollision(target, parts.query, context);
}

type ShapeContext = { readonly requestId: string; readonly resourceId: string };

// The path-templated URL plus the query and body values a request carries
interface BackendRequestParts {
  readonly url: string;
  readonly query: Record<string, unknown>;
  // Present when a JSON body should be sent; `value` is what gets encoded
  readonly body?: { readonly value: unknown };
}

function acceptsBody(method: BackendMethod): boolean {
  return method !== 'GET' && method !== 'DELETE';
}

/**
 * Split validated input into URL, query and body according to
 * `handler.inputBindings`. `call()` and `validateBackendRequestShape()` both
 * use it, so they cannot disagree about the request an input describes. Throws
 * only `CommerceError('INPUT_INVALID')`.
 */
function buildBackendRequestParts(
  handler: BackendHandler,
  input: Record<string, unknown>,
  context: ShapeContext,
): BackendRequestParts {
  const bindings = handler.inputBindings;
  if (bindings === undefined) {
    const { url, remaining } = applyPathTemplate(handler.url, input, context);
    return acceptsBody(handler.method)
      ? { url, query: {}, body: { value: remaining } }
      : { url, query: remaining };
  }

  const pathValues =
    bindings.path === undefined ? {} : resolveBoundGroup(input, bindings.path, 'path', context);
  const { url } = applyPathTemplate(handler.url, pathValues, context);
  const query =
    bindings.query === undefined ? {} : resolveBoundGroup(input, bindings.query, 'query', context);

  // An absent body value sends no body rather than `null`. A required body is
  // enforced earlier, by `required` in the resource's input schema.
  const bodyValue = bindings.body === undefined ? undefined : input[bindings.body];
  if (bodyValue === undefined || !acceptsBody(handler.method)) return { url, query };
  return { url, query, body: { value: bodyValue } };
}

function resolveBoundGroup(
  input: Record<string, unknown>,
  key: string,
  kind: 'path' | 'query',
  context: ShapeContext,
): Record<string, unknown> {
  const value = input[key];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new CommerceError(
      'INPUT_INVALID',
      `Input "${key}" must be an object of ${kind} parameters`,
      { ...context, details: { field: key } },
    );
  }
  return value;
}

function checkQueryCollision(
  target: URL,
  remaining: Record<string, unknown>,
  context: { readonly requestId: string; readonly resourceId: string },
): void {
  const templateKeys = new Set(target.searchParams.keys());
  for (const key of Object.keys(remaining)) {
    if (templateKeys.has(key)) {
      throw new CommerceError(
        'INPUT_INVALID',
        `Input key "${key}" collides with a query parameter already set on backend.url`,
        { requestId: context.requestId, resourceId: context.resourceId, details: { field: key } },
      );
    }
  }
}

// encodeURIComponent leaves "." alone, and new URL() then resolves a "." or
// ".." segment, stepping outside the template's directory. Slashes are
// escaped, so only these exact values (and "", an empty segment) need refusing.
const TRAVERSAL_PATH_VALUES = new Set(['', '.', '..']);

function applyPathTemplate(
  template: string,
  input: Record<string, unknown>,
  context: ShapeContext,
): { url: string; remaining: Record<string, unknown> } {
  const remaining: Record<string, unknown> = { ...input };
  let missing: string | undefined;
  let invalid: string | undefined;
  const url = template.replace(PATH_PARAM_PATTERN, (_match, key: string) => {
    // Object.hasOwn, not `in`: a parameter named "constructor" or "toString"
    // would otherwise resolve to the inherited Object.prototype member
    if (!Object.hasOwn(remaining, key)) {
      missing = key;
      return '';
    }
    const value = remaining[key];
    delete remaining[key];
    const raw = stringifyPrimitive(value);
    if (TRAVERSAL_PATH_VALUES.has(raw)) {
      invalid = key;
      return '';
    }
    return encodeURIComponent(raw);
  });
  if (missing !== undefined) {
    // Config refuses a template parameter the input schema cannot supply.
    // This covers a hand-built `CommerceResource` that skipped config: through
    // validateBackendRequestShape it fails before payment, instead of calling
    // the backend with an empty path segment.
    throw new CommerceError('INPUT_INVALID', `Path parameter "${missing}" was not supplied`, {
      ...context,
      details: { field: missing },
    });
  }
  if (invalid !== undefined) {
    throw new CommerceError('INPUT_INVALID', `Path parameter "${invalid}" is not a valid value`, {
      ...context,
      details: { field: invalid },
    });
  }
  return { url, remaining };
}

function stringifyPrimitive(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// `Headers` throws a TypeError on an illegal name or value. The error is
// rethrown typed and without `cause`: the TypeError quotes the value, which may
// be a credential.
function buildHeaders(handler: BackendHandler, context: ShapeContext): Headers {
  try {
    return new Headers(handler.headers);
  } catch {
    throw invalidHeaderError(context);
  }
}

function setHeader(headers: Headers, name: string, value: string, context: ShapeContext): void {
  try {
    headers.set(name, value);
  } catch {
    throw invalidHeaderError(context);
  }
}

function invalidHeaderError(context: ShapeContext): CommerceError {
  return new CommerceError('BACKEND_ERROR', 'Backend request headers are invalid', {
    ...context,
    details: { reason: 'invalid-header' },
  });
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
