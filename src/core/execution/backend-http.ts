/**
 * The only outbound HTTP path to a merchant backend.
 *
 * - Uses global `fetch` and always applies a bound timeout via `AbortSignal.timeout`.
 * - `redirect: 'manual'` - a 3xx response is treated as a `BACKEND_ERROR`, never
 * followed (SSRF hardening).
 * - `{param}` segments in `handler.url` are filled from validated input and
 * URL-encoded; whatever remains goes to the query string (GET/DELETE) or a
 * JSON body (POST/PUT/PATCH). `handler.inputBindings` replaces that
 * leftover rule with one that names each group explicitly - see
 * `buildBackendRequestParts`.
 */
import {
  type BackendHandler,
  type BackendMethod,
  DEFAULT_BACKEND_TIMEOUT_MS,
} from '../domain/resource.js';
import { CommerceError } from '../errors/index.js';
import type { BackendExecutor, BackendRequest, BackendResponse } from '../interfaces/backend.js';
import { type Logger, NOOP_LOGGER } from '../interfaces/logger.js';

const MAX_BODY_SNIPPET_LENGTH = 512;
/**
 * The one canonical `{param}` grammar. Extraction, substitution, the config
 * gate and `doctor`'s probe all go through it.
 *
 * `-` and `.` are admitted: `/report/{report-id}` is ordinary
 * REST, and under the previous `[a-zA-Z0-9_]+` class it matched *nothing*. It
 * was therefore invisible to the config gate, survived substitution as a
 * literal, and a paid resource settled the buyer's payment before sending
 * `/report/%7Breport-id%7D` to a backend that 404s - the earlier money bug,
 * reachable again through the character class rather than through the check.
 */
const PATH_PARAM_PATTERN = /\{([a-zA-Z0-9_.-]+)\}/g;
/** A hostile or broken backend can otherwise materialise an arbitrarily
 * large response in memory - AbortSignal.timeout bounds it by *time*, not
 * bytes. 1 MB is generous for a JSON API response. */
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface HttpBackendExecutorOptions {
  /** Override for `fetch`, used in tests. Defaults to the global implementation. */
  readonly fetchImpl?: typeof fetch;
  /** A non-2xx backend body is logged here (debug), never shipped to the client. */
  readonly logger?: Logger;
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
    const inputRecord = isPlainObject(request.input) ? request.input : {};

    const context = { requestId: request.requestId, resourceId: request.resourceId };
    // Throws INPUT_INVALID for every shape problem. The pipeline already ran
    // the same call pre-payment through validateBackendRequestShape(); this is
    // defence in depth for a caller that bypasses it, not the normal path.
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

    // Belt-and-braces beyond the per-parameter check above: whatever the
    // templated path resolved to must still live under the template's own
    // literal (pre-`{param}`) prefix. Templating something other than a path
    // segment (e.g. the host) is not a documented usage; if the literal
    // prefix does not even parse as a URL, skip this extra check rather than
    // fail a request the per-parameter check already covers.
    const literalPrefix = handler.url.split('{')[0] ?? handler.url;
    try {
      const literalPrefixPathname = new URL(literalPrefix).pathname;
      if (!target.pathname.startsWith(literalPrefixPathname)) {
        throw new CommerceError(
          'INPUT_INVALID',
          'Path parameters resolved outside the configured backend path',
          {
            requestId: request.requestId,
            resourceId: request.resourceId,
          },
        );
      }
    } catch (error) {
      if (error instanceof CommerceError) throw error;
    }

    const headers: Record<string, string> = { ...(handler.headers ?? {}) };
    let body: string | undefined;

    //.set() REPLACES an existing param, so without this check a caller
    // input key with the same name as an operator-baked-in query param
    // (?apikey=SECRET in handler.url) silently overwrites it.
    // Shared with validateBackendRequestShape() - that copy runs
    // *before* payment, this one is defence in depth.
    checkQueryCollision(target, parts.query, context);
    for (const [key, value] of Object.entries(parts.query)) {
      target.searchParams.set(key, stringifyPrimitive(value));
    }
    if (parts.body !== undefined) {
      body = JSON.stringify(parts.body.value);
      // A configured Content-Type stays authoritative: a backend wanting
      // `application/vnd.x+json` says so in config and we do not override it.
      if (!hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'application/json';
      }
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

    const responseHeaders = headersToRecord(response.headers);
    const contentType = response.headers.get('content-type') ?? '';
    let parsedBody: unknown;
    try {
      parsedBody = await parseBody(response, contentType);
    } catch (error) {
      const tooLarge =
        error instanceof Error && error.message.startsWith('response-body-too-large');
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
      // The backend status is ours to state; the backend's own response body
      // is not - a merchant backend in verbose/dev-error mode routinely
      // emits stack traces, hostnames or SQL fragments, and this gateway is
      // not the one who gets to decide those are safe to forward to whoever
      // called the (possibly free, possibly unauthenticated) resource. Log
      // it for the operator; never put it in a client-visible field.
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
 * The traversal and query-collision checks below must run before payment,
 * not only inside `call()` - pipeline step 6, which is *after*
 * verify -> reserve -> settle.
 * Both throw INPUT_INVALID, which schema validation (step 2) cannot catch
 * (it validates against `resource.inputSchema`, which knows nothing about
 * the URL template a bad value would collide with). Concretely: a paid,
 * path-templated resource called with `{ city: "" }` would settle the buyer's
 * payment on-chain and then never call the backend - payment without
 * delivery, no refund, no release of the reserved authorisation. Both
 * checks are pure functions of `(handler.url, input)` with no I/O, so the
 * pipeline calls this immediately after schema validation, *before* price
 * resolution - before any payment provider is even selected. `call()` keeps
 * its own copy as defence in depth (it is a public class; the pipeline is
 * not the only possible caller).
 */
/**
 * `{param}` names in a `backend.url` template, in declaration order.
 * Exported so `src/config`'s `normaliseResource` can
 * cross-check every template parameter against the resource's input schema
 * at config load - the same regex, not a second copy that could silently
 * drift out of sync with what this file actually treats as a path
 * parameter.
 */
export function extractPathParameterNames(url: string): string[] {
  return [...url.matchAll(PATH_PARAM_PATTERN)].map((match) => match[1] as string);
}

/**
 * A brace left over after every legal `{param}` is removed, or `undefined`.
 *
 * Widening the grammar fixes the *common* spelling; it cannot fix every one.
 * `{report id}`, `{a/b}`, `{}` and an unbalanced `{` still match nothing, and
 * "matches nothing" is precisely the silent-literal shape that costs a buyer
 * money on a paid resource. So the rule is inverted: rather than enumerating
 * what is illegal, anything brace-shaped that is *not* a recognised parameter
 * is refused at config load. Exported so `src/config` applies it - the
 * grammar and its residue must never live in two files.
 */
export function findUnparsedBraceToken(url: string): string | undefined {
  const residue = url.replace(PATH_PARAM_PATTERN, '');
  const index = residue.search(/[{}]/);
  if (index === -1) return undefined;
  // Report the offending run, not just the character, so the error is fixable.
  const token = /\{[^{}]*\}?|\}/.exec(residue.slice(index));
  return token?.[0] ?? residue[index];
}

export function validateBackendRequestShape(
  handler: BackendHandler,
  input: unknown,
  context: ShapeContext,
): void {
  const inputRecord = isPlainObject(input) ? input : {};

  // Every shape error - missing or invalid path parameter, a bound group that
  // is not an object - throws INPUT_INVALID from here, before payment.
  const parts = buildBackendRequestParts(handler, inputRecord, context);

  let target: URL;
  try {
    target = new URL(parts.url);
  } catch {
    return; // call() surfaces the real BACKEND_ERROR for an unparseable URL.
  }
  checkQueryCollision(target, parts.query, context);
}

type ShapeContext = { readonly requestId: string; readonly resourceId: string };

/** The path-templated URL plus the query and body values a request carries. */
interface BackendRequestParts {
  readonly url: string;
  readonly query: Record<string, unknown>;
  /** Present when a JSON body should be sent; `value` is what gets encoded. */
  readonly body?: { readonly value: unknown };
}

function acceptsBody(method: BackendMethod): boolean {
  return method !== 'GET' && method !== 'DELETE';
}

/**
 * Split validated input into URL, query and body according to
 * `handler.inputBindings` - the single place either mode is decided, so
 * `call()` and the pre-payment `validateBackendRequestShape()` can never
 * disagree about what request the input describes.
 *
 * Throws only `CommerceError('INPUT_INVALID')`, which is what makes it safe to
 * run before pricing.
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

  // An absent body value sends no body at all rather than `null`: a request
  // body the operation does not require is simply not there. A body the
  // operation *does* require is caught one step earlier, by `required` in the
  // resource's input schema - also before payment.
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
  if (!isPlainObject(value)) {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// encodeURIComponent does not escape "." - a raw ".."/"." path-parameter
// value survives it and new URL() then normalises the segment away, letting
// a caller step outside the template's own directory (bounded traversal:
// slashes ARE escaped, so only removing segments, never adding them). Reject
// these exact values at substitution time instead of shipping them.
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
    // Object.hasOwn, not `key in remaining`: `in` also matches inherited
    // Object.prototype names ("constructor", "toString", …), which a
    // config-authored template naming a path param after one of them would
    // otherwise silently resolve to the wrong (inherited) value.
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
    // Tempting to shrug this off as a config/schema mismatch rather than bad
    // caller input. But a paid, `{param}`-templated resource whose input can
    // never supply it would reach settle() on every call - the buyer pays, the
    // backend is never called, no refund. `normaliseResource` (src/config) is
    // the root-cause fix, rejecting the shape at config load; throwing here
    // stops a hand-built `CommerceResource` from reintroducing the money bug
    // by skipping config validation.
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

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
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
        throw new Error(`response-body-too-large:${maxBytes}`);
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
