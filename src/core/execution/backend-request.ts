/**
 * Shapes a backend request from validated input: the path template, query,
 * body and forwarded headers. The pipeline checks the shape before pricing, so
 * a request the backend cannot receive fails before any payment.
 */
import type { BackendHandler, BackendMethod } from '../domain/resource';
import { CommerceError } from '../errors';
import { isRecord } from '../is-record';

// Never forward credentials, transport headers or fields set by the executor
const NEVER_FORWARDED_HEADER =
  /^(authorization|cookie|set-cookie|host|content-length|content-type|connection|keep-alive|te|trailer|transfer-encoding|upgrade|idempotency-key|proxy-.*)$/;

// The one `{param}` grammar, shared by substitution, config, `doctor` and the
// OpenAPI importer. It admits `-` and `.` because
// `/report/{report-id}` is ordinary REST. Config refuses any other brace
// (findUnparsedBraceToken).
const PATH_PARAM_PATTERN = /\{([a-zA-Z0-9_.-]+)\}/g;

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
 * Check path values, query collisions and headers before pricing. `call()`
 * repeats these checks. Invalid input or forwarded headers raise
 * `INPUT_INVALID`; invalid configured headers raise `BACKEND_ERROR`.
 * An unparseable URL remains a call-time error. Does no I/O.
 */
export function validateBackendRequestShape(
  handler: BackendHandler,
  input: unknown,
  context: ShapeContext,
  backendHeaders?: Readonly<Record<string, string>>,
): void {
  const inputRecord = isRecord(input) ? input : {};

  // Every shape error (missing or invalid path parameter, a bound group that is
  // not an object) throws INPUT_INVALID here
  const parts = buildBackendRequestParts(handler, inputRecord, context);
  // Config refuses a bad header at load; this covers a hand-built resource
  buildHeaders(handler, context, backendHeaders);

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
export function buildBackendRequestParts(
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

export function checkQueryCollision(
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

export function stringifyPrimitive(value: unknown): string {
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
export function buildHeaders(
  handler: BackendHandler,
  context: ShapeContext,
  forwarded: Readonly<Record<string, string>> = {},
): Headers {
  let headers: Headers;
  try {
    headers = new Headers(handler.headers);
  } catch {
    throw invalidHeaderError(context);
  }
  // Caller headers cannot replace operator-configured backend credentials
  for (const [name, value] of Object.entries(forwarded)) {
    if (NEVER_FORWARDED_HEADER.test(name.toLowerCase())) continue;
    try {
      if (!headers.has(name)) headers.set(name, value);
    } catch {
      throw new CommerceError('INPUT_INVALID', 'A forwarded request header is invalid', {
        ...context,
        details: { reason: 'invalid-forwarded-header' },
      });
    }
  }
  return headers;
}

export function setHeader(
  headers: Headers,
  name: string,
  value: string,
  context: ShapeContext,
): void {
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
