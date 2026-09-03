/**
 * OpenAPI parameters and request body -> a canonical input schema plus
 * `backend.inputBindings`.
 *
 * Locations are namespaced (`path` / `query` / `body`) so a `?id=` and a
 * `{id}` in the same operation cannot collide, and so the executor can source
 * each group independently. Anything the executor would not send the way the
 * API expects is refused rather than approximated: a required parameter we
 * cannot represent skips the operation, an optional one is omitted with a
 * warning. Approximating it would produce a resource that looks importable,
 * takes payment, and then calls the backend wrongly.
 */
import type { JsonSchema } from '../core/domain/common.js';
import { extractPathParameterNames } from '../core/execution/index.js';
import { dereference } from './refs.js';
import { convertSchema, isPrimitiveSchema } from './schema.js';
import type {
  ImportDiagnostic,
  LoadedOpenApiDocument,
  OpenApiOperationCandidate,
} from './types.js';

/** Top-level input property names. Also the binding values. */
const PATH_GROUP = 'path';
const QUERY_GROUP = 'query';
const BODY_GROUP = 'body';

/**
 * OpenAPI: parameters named these "SHALL be ignored" — they are transport
 * concerns, and `Authorization` in particular is operator configuration that
 * must never become an agent-supplied input.
 */
const IGNORED_HEADER_NAMES = new Set(['accept', 'content-type', 'authorization']);

/** Serialization styles the executor's plain `key=value` query cannot produce. */
const UNSUPPORTED_QUERY_STYLES = new Set(['deepObject', 'spaceDelimited', 'pipeDelimited']);

export interface RequestBindings {
  readonly path?: string;
  readonly query?: string;
  readonly body?: string;
}

export type RequestMapping =
  | {
      readonly supported: true;
      readonly inputSchema: JsonSchema;
      readonly inputBindings: RequestBindings;
      /** Set only for a vendor `+json` body, which needs a static Content-Type. */
      readonly contentType?: string;
      /** Schema constraints dropped because the gateway does not enforce them. */
      readonly droppedKeywords: readonly string[];
      readonly diagnostics: readonly ImportDiagnostic[];
    }
  | { readonly supported: false; readonly diagnostics: readonly ImportDiagnostic[] };

export function mapRequest(
  loaded: LoadedOpenApiDocument,
  candidate: OpenApiOperationCandidate,
): RequestMapping {
  const { document } = loaded;
  const diagnostics: ImportDiagnostic[] = [];
  const dropped = new Set<string>();
  const operation = candidate.resourceId;

  const warn = (code: string, message: string): void => {
    diagnostics.push({ severity: 'warning', code, operation, message });
  };
  const skip = (code: string, message: string): RequestMapping => {
    diagnostics.push({
      severity: 'error',
      code,
      operation,
      message: `Skipped ${candidate.method} ${candidate.path}: ${message}`,
    });
    return { supported: false, diagnostics };
  };

  const pathProperties: Record<string, unknown> = {};
  const queryProperties: Record<string, unknown> = {};
  const requiredQuery: string[] = [];
  const templateParams = new Set(extractPathParameterNames(candidate.path));

  for (const parameter of mergeParameters(document, candidate.parameters)) {
    const name = typeof parameter['name'] === 'string' ? parameter['name'] : undefined;
    const location = typeof parameter['in'] === 'string' ? parameter['in'] : undefined;
    if (name === undefined || location === undefined) continue;
    const required = parameter['required'] === true || location === 'path';
    const label = `${location} parameter "${name}"`;

    if (location === 'header' || location === 'cookie') {
      if (location === 'header' && IGNORED_HEADER_NAMES.has(name.toLowerCase())) continue;
      if (required) {
        return skip(
          'unsupported-required-parameter',
          `${label} is required, and ${location} parameters are operator configuration in this release, not agent input`,
        );
      }
      warn(
        'unsupported-optional-parameter',
        `Omitted optional ${label}: ${location} parameters are not imported. Configure it under backend.headers if the API needs it`,
      );
      continue;
    }
    if (location !== 'path' && location !== 'query') {
      if (required) return skip('unsupported-required-parameter', `${label} has unknown location`);
      warn('unsupported-optional-parameter', `Omitted optional ${label}: unknown location`);
      continue;
    }

    const unsupported = describeUnsupportedParameter(document, parameter, location);
    if (unsupported !== undefined) {
      if (required) return skip('unsupported-required-parameter', `${label} ${unsupported}`);
      warn('unsupported-optional-parameter', `Omitted optional ${label}: it ${unsupported}`);
      continue;
    }

    const converted = convertSchema(document, parameter['schema']);
    if (!converted.supported) {
      if (required) return skip('unsupported-required-parameter', `${label} ${converted.reason}`);
      warn('unsupported-optional-parameter', `Omitted optional ${label}: ${converted.reason}`);
      continue;
    }
    for (const keyword of converted.dropped) dropped.add(keyword);

    if (location === 'path') {
      if (!templateParams.has(name)) {
        warn(
          'path-parameter-not-in-template',
          `Ignored path parameter "${name}": it does not appear in "${candidate.path}"`,
        );
        continue;
      }
      pathProperties[name] = converted.schema;
    } else {
      queryProperties[name] = converted.schema;
      if (required) requiredQuery.push(name);
    }
  }

  for (const param of templateParams) {
    if (!Object.hasOwn(pathProperties, param)) {
      return skip(
        'undeclared-path-parameter',
        `"{${param}}" appears in the path but is not declared as a path parameter, so a caller could never supply it`,
      );
    }
  }

  const body = resolveBody(document, candidate);
  if (body.kind === 'unsupported') {
    if (body.required) return skip('unsupported-request-body', body.reason);
    warn('unsupported-request-body', `Omitted the request body: ${body.reason}`);
  }
  if (body.kind === 'schema') {
    for (const keyword of body.dropped) dropped.add(keyword);
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const bindings: { path?: string; query?: string; body?: string } = {};

  if (Object.keys(pathProperties).length > 0) {
    properties[PATH_GROUP] = closedObject(pathProperties, Object.keys(pathProperties));
    // OpenAPI path parameters are always required, and a missing one makes the
    // request unbuildable — which on a paid resource is payment with no
    // delivery, so config rejects the shape at load time too.
    required.push(PATH_GROUP);
    bindings.path = PATH_GROUP;
  }
  if (Object.keys(queryProperties).length > 0) {
    properties[QUERY_GROUP] = closedObject(queryProperties, requiredQuery);
    if (requiredQuery.length > 0) required.push(QUERY_GROUP);
    bindings.query = QUERY_GROUP;
  }
  if (body.kind === 'schema') {
    properties[BODY_GROUP] = body.schema;
    if (body.required) required.push(BODY_GROUP);
    bindings.body = BODY_GROUP;
  }

  return {
    supported: true,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    inputBindings: bindings,
    ...(body.kind === 'schema' && body.contentType !== undefined
      ? { contentType: body.contentType }
      : {}),
    droppedKeywords: [...dropped],
    diagnostics,
  };
}

/**
 * Path Item parameters first, operation parameters second, with the OpenAPI
 * identity rule: a parameter is the same one when `name` *and* `in` match, and
 * the operation's own definition wins.
 */
function mergeParameters(
  document: Record<string, unknown>,
  parameters: readonly unknown[],
): Record<string, unknown>[] {
  const byIdentity = new Map<string, Record<string, unknown>>();
  for (const raw of parameters) {
    const resolved = dereference(document, raw).value;
    if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) continue;
    const parameter = resolved as Record<string, unknown>;
    byIdentity.set(`${String(parameter['in'])}:${String(parameter['name'])}`, parameter);
  }
  return [...byIdentity.values()];
}

/**
 * Whether the executor can actually send this parameter the way the API reads
 * it. It writes one `key=value` pair per query parameter and substitutes one
 * URL-encoded value per path segment, so anything that serialises to several
 * pairs or to a structured segment is out of scope for this release.
 */
function describeUnsupportedParameter(
  document: Record<string, unknown>,
  parameter: Record<string, unknown>,
  location: 'path' | 'query',
): string | undefined {
  if (parameter['content'] !== undefined) {
    return 'uses the `content` form, whose media-type serialization the gateway does not perform';
  }
  const style = parameter['style'];
  if (location === 'query' && typeof style === 'string' && UNSUPPORTED_QUERY_STYLES.has(style)) {
    return `uses style "${style}", which the gateway does not serialize`;
  }
  if (location === 'path' && typeof style === 'string' && style !== 'simple') {
    return `uses style "${style}"; the gateway substitutes plain values only`;
  }
  const converted = convertSchema(document, parameter['schema']);
  if (!converted.supported) return converted.reason;
  if (!isPrimitiveSchema(converted.schema)) {
    return 'is not a primitive; object and array parameters need serialization the gateway does not perform';
  }
  return undefined;
}

type BodyResult =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'schema';
      readonly schema: JsonSchema;
      readonly required: boolean;
      readonly contentType?: string;
      readonly dropped: readonly string[];
    }
  | { readonly kind: 'unsupported'; readonly required: boolean; readonly reason: string };

function resolveBody(
  document: Record<string, unknown>,
  candidate: OpenApiOperationCandidate,
): BodyResult {
  if (candidate.requestBody === undefined) return { kind: 'none' };
  const resolved = dereference(document, candidate.requestBody).value;
  if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) {
    return { kind: 'none' };
  }
  const requestBody = resolved as Record<string, unknown>;
  const required = requestBody['required'] === true;

  if (candidate.method === 'GET' || candidate.method === 'DELETE') {
    // The executor sends no body on these, and config refuses a body binding
    // for them. Silently generating one would produce a resource whose
    // payload never arrives.
    return {
      kind: 'unsupported',
      required: false,
      reason: `a ${candidate.method} request body is not sent by the gateway`,
    };
  }

  const content = requestBody['content'];
  if (!isRecord(content)) return { kind: 'none' };
  const mediaType = pickJsonMediaType(Object.keys(content));
  if (mediaType === undefined) {
    return {
      kind: 'unsupported',
      required,
      reason: `no JSON request body content type (found: ${Object.keys(content).join(', ') || 'none'}). Only application/json and application/*+json are supported — multipart and form data are never serialized as JSON`,
    };
  }
  const media = content[mediaType];
  const schemaNode = isRecord(media) ? media['schema'] : undefined;
  if (schemaNode === undefined) {
    // A body with no schema accepts anything; an open object is the honest
    // representation and the loader closes nothing it was not told to close.
    return {
      kind: 'schema',
      schema: { type: 'object', additionalProperties: true },
      required,
      ...(mediaType === 'application/json' ? {} : { contentType: mediaType }),
      dropped: [],
    };
  }
  const converted = convertSchema(document, schemaNode);
  if (!converted.supported) return { kind: 'unsupported', required, reason: converted.reason };
  return {
    kind: 'schema',
    schema: converted.schema,
    required,
    ...(mediaType === 'application/json' ? {} : { contentType: mediaType }),
    dropped: converted.dropped,
  };
}

/** Exact `application/json` wins; otherwise the first `+json` in sorted order. */
function pickJsonMediaType(keys: readonly string[]): string | undefined {
  const normalised = keys.map((key) => ({ key, type: key.split(';')[0]?.trim().toLowerCase() }));
  const exact = normalised.find((entry) => entry.type === 'application/json');
  if (exact !== undefined) return exact.key;
  return [...normalised]
    .sort((a, b) => (a.type ?? '').localeCompare(b.type ?? ''))
    .find((entry) => entry.type?.startsWith('application/') && entry.type.endsWith('+json'))?.key;
}

function closedObject(
  properties: Record<string, unknown>,
  required: readonly string[],
): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
