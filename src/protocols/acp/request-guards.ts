/**
 * Everything that must hold before an ACP request reaches the pipeline, in a
 * fixed order that fails closed at the first step that does not hold: route ->
 * bearer auth -> API-Version -> Idempotency-Key -> body size -> content type
 * -> JSON -> ACP request schema. A request failing any step never reaches the
 * pipeline.
 */
import type { IncomingMessage } from 'node:http';
import { readCappedBody } from '../http';
import {
  ACP_API_VERSION,
  ACP_API_VERSION_HEADER,
  ACP_IDEMPOTENCY_KEY_HEADER,
  ACP_MAX_REQUEST_ID_LENGTH,
  ACP_REQUEST_ID_HEADER,
} from './constants';
import { type AcpFailure, acpFailure } from './errors';
import { ACP_MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency/store';
import { type AcpRouteMatch, matchAcpRoute } from './router';
import { type AcpDefinition, validateAcpDocument } from './validation';

// A second line behind the gateway mount's cap, bounding what this adapter
// buffers if it is mounted without that guard
const ACP_MAX_REQUEST_BODY_BYTES = 256 * 1024;

// Which released request definition each operation's body is validated against
const REQUEST_DEFINITIONS: Readonly<Record<AcpRouteMatch['operation'], AcpDefinition | undefined>> =
  {
    createCheckoutSession: 'createRequest',
    updateCheckoutSession: 'updateRequest',
    completeCheckoutSession: 'completeRequest',
    cancelCheckoutSession: 'cancelRequest',
    getCheckoutSession: undefined,
  };

export interface AcpGuardedRequest {
  readonly route: AcpRouteMatch;
  /** Validated ACP request document. `{}` for a body-less route */
  readonly body: Record<string, unknown>;
  /** The caller's `Request-Id`, bounded and filtered, when it sent a usable one */
  readonly requestId?: string;
  /** Present on every body-bearing route, where ACP makes it mandatory */
  readonly idempotencyKey?: string;
}

export type AcpGuardResult =
  | { readonly ok: true; readonly value: AcpGuardedRequest }
  | ({ readonly ok: false } & AcpFailure);

export interface AcpGuardOptions {
  readonly mountPath: string;
  /** `createBearerCheck` over the configured token */
  readonly isAuthorized: (authorizationHeader: string | undefined) => boolean;
  readonly maxBodyBytes?: number;
}

export async function guardAcpRequest(
  req: IncomingMessage,
  options: AcpGuardOptions,
): Promise<AcpGuardResult> {
  const matched = matchAcpRoute(req.method, req.url, options.mountPath);
  if (matched.kind === 'not-found') {
    return failed(acpFailure(404, 'invalid_request', 'not_found', 'Unknown ACP route.'));
  }
  if (matched.kind === 'method-not-allowed') {
    return failed(
      acpFailure(
        405,
        'invalid_request',
        'method_not_allowed',
        `This ACP route accepts ${matched.allow.join(', ')}.`,
      ),
    );
  }
  const route = matched.route;

  // Before any body is read, so an unauthenticated caller cannot make this
  // adapter buffer or parse. Only the bearer token authenticates: a
  // `Signature` header is not verified and never stands in for it.
  if (!options.isAuthorized(header(req, 'authorization'))) {
    return failed(
      acpFailure(
        401,
        'invalid_request',
        'unauthorized',
        'A valid "Authorization: Bearer <token>" header is required.',
      ),
    );
  }

  const version = header(req, ACP_API_VERSION_HEADER);
  if (version === undefined || version.trim().length === 0) {
    return failed(
      acpFailure(
        400,
        'invalid_request',
        'missing_api_version',
        `The ${ACP_API_VERSION_HEADER} header is required.`,
        { supportedVersions: [ACP_API_VERSION] },
      ),
    );
  }
  if (version.trim() !== ACP_API_VERSION) {
    // Never mapped to the pinned version: "latest", an older snapshot and a
    // typo get the same answer
    return failed(
      acpFailure(
        400,
        'invalid_request',
        'unsupported_api_version',
        'The requested API version is not supported.',
        { supportedVersions: [ACP_API_VERSION] },
      ),
    );
  }

  // Checked before the body is read: a POST without a usable key can never be
  // executed, so reading its body would be wasted work
  let idempotencyKey: string | undefined;
  if (route.acceptsBody) {
    const presented = header(req, ACP_IDEMPOTENCY_KEY_HEADER)?.trim();
    if (presented === undefined || presented.length === 0) {
      return failed(
        acpFailure(
          400,
          'invalid_request',
          'idempotency_key_required',
          `The ${ACP_IDEMPOTENCY_KEY_HEADER} header is required on this ACP operation.`,
        ),
      );
    }
    // Bounded and printable ASCII like Request-Id: the key is echoed in a
    // response header, where a CRLF would split the response
    if (presented.length > ACP_MAX_IDEMPOTENCY_KEY_LENGTH || !isVisibleAscii(presented)) {
      return failed(
        acpFailure(
          400,
          'invalid_request',
          'idempotency_key_invalid',
          `The ${ACP_IDEMPOTENCY_KEY_HEADER} header must be 1-${ACP_MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters.`,
        ),
      );
    }
    idempotencyKey = presented;
  }

  const read = await readCappedBody(req, options.maxBodyBytes ?? ACP_MAX_REQUEST_BODY_BYTES);
  if (read.kind === 'too-large') {
    return failed(
      acpFailure(
        413,
        'invalid_request',
        'request_body_too_large',
        'The request body is too large.',
      ),
    );
  }
  if (read.kind === 'unreadable') {
    return failed(
      acpFailure(
        400,
        'invalid_request',
        'invalid_request_body',
        'Could not read the request body.',
      ),
    );
  }

  const raw = read.text;
  const contentTypeFailure = checkContentType(header(req, 'content-type'), raw, route);
  if (contentTypeFailure !== undefined) return failed(contentTypeFailure);

  const definition = REQUEST_DEFINITIONS[route.operation];
  if (definition === undefined) {
    // GET carries no document; a body on it is ignored, not validated
    return ok(route, {}, req, idempotencyKey);
  }

  let body: unknown;
  if (raw.trim().length === 0) {
    // An absent body is an empty document, which the schema accepts (cancel)
    // or rejects (create) on its own terms
    body = {};
  } else {
    try {
      body = JSON.parse(raw);
    } catch {
      return failed(
        acpFailure(400, 'invalid_request', 'invalid_json', 'The request body is not valid JSON.'),
      );
    }
  }

  const failure = validateAcpDocument(definition, body);
  if (failure !== undefined) {
    // Only the pointer into the caller's document travels, not the Ajv message
    return failed(
      acpFailure(400, 'invalid_request', 'invalid_request_body', 'The request body is invalid.', {
        ...(failure.path !== undefined ? { param: failure.path } : {}),
      }),
    );
  }

  return ok(route, body as Record<string, unknown>, req, idempotencyKey);
}

function checkContentType(
  contentType: string | undefined,
  raw: string,
  route: AcpRouteMatch,
): AcpFailure | undefined {
  if (!route.acceptsBody) return undefined;
  if (contentType === undefined) {
    // A POST with no body at all (a bare cancel) needs no content type
    return raw.trim().length === 0
      ? undefined
      : acpFailure(
          415,
          'invalid_request',
          'unsupported_media_type',
          'ACP request bodies must be sent as "application/json".',
        );
  }
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
  if (mediaType === 'application/json' || mediaType?.endsWith('+json')) return undefined;
  return acpFailure(
    415,
    'invalid_request',
    'unsupported_media_type',
    'ACP request bodies must be sent as "application/json".',
  );
}

function ok(
  route: AcpRouteMatch,
  body: Record<string, unknown>,
  req: IncomingMessage,
  idempotencyKey: string | undefined,
): AcpGuardResult {
  const requestId = normalizeRequestId(header(req, ACP_REQUEST_ID_HEADER));
  return {
    ok: true,
    value: {
      route,
      body,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    },
  };
}

function failed(failure: AcpFailure): AcpGuardResult {
  return { ok: false, ...failure };
}

/**
 * The caller's correlation id, echoed back but never used as the gateway's own
 * request id. It is caller-controlled text bound for a response header, so it
 * is truncated and dropped unless it is printable ASCII.
 */
function normalizeRequestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().slice(0, ACP_MAX_REQUEST_ID_LENGTH);
  if (trimmed.length === 0) return undefined;
  if (!isVisibleAscii(trimmed)) return undefined;
  return trimmed;
}

function isVisibleAscii(value: string): boolean {
  return !/[^\x20-\x7e]/.test(value);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
