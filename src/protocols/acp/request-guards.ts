/**
 * Everything that must hold before an ACP request reaches the pipeline.
 *
 * The sequence is fixed and fails closed at the first step that does not hold:
 * route -> bearer auth -> API-Version -> content type -> body size -> JSON ->
 * ACP request schema. Nothing below this file runs for a request that fails
 * any of them, which is what makes "no pipeline call on a guard failure"
 * checkable rather than a claim.
 */
import type { IncomingMessage } from 'node:http';
import { isAuthorizedBearer } from './auth.js';
import {
  ACP_API_VERSION,
  ACP_API_VERSION_HEADER,
  ACP_MAX_REQUEST_ID_LENGTH,
  ACP_REQUEST_ID_HEADER,
} from './constants.js';
import { type AcpFailure, acpFailure } from './errors.js';
import { type AcpRouteMatch, matchAcpRoute } from './router.js';
import { type AcpDefinition, validateAcpDocument } from './validation.js';

/**
 * A second line behind the gateway mount's own cap, so this adapter bounds
 * what it buffers even if it is ever mounted without that guard.
 */
export const ACP_MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** Which released request definition each operation's body is validated against. */
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
  /** Validated ACP request document. `{}` for a body-less route. */
  readonly body: Record<string, unknown>;
  /** The caller's `Request-Id`, bounded and filtered, when it sent a usable one. */
  readonly requestId?: string;
}

export type AcpGuardResult =
  | { readonly ok: true; readonly value: AcpGuardedRequest }
  | ({ readonly ok: false } & AcpFailure);

export interface AcpGuardOptions {
  readonly mountPath: string;
  readonly token: string;
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

  // Before anything reads a body: an unauthenticated caller must not be able
  // to make this adapter buffer or parse.
  if (!isAuthorizedBearer(header(req, 'authorization'), options.token)) {
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
    // Never mapped to the pinned version. "latest", an older snapshot and a
    // typo are the same answer: this deployment serves one contract.
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

  const read = await readBody(req, options.maxBodyBytes ?? ACP_MAX_REQUEST_BODY_BYTES);
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
    // GET carries no document; a body on it is ignored rather than validated.
    return ok(route, {}, req);
  }

  let body: unknown;
  if (raw.trim().length === 0) {
    // An absent body is an empty document, which the pinned schema then
    // accepts (cancel) or rejects (create) on its own terms.
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
    // Only the caller's own pointer travels; the Ajv message stays here.
    return failed(
      acpFailure(400, 'invalid_request', 'invalid_request_body', 'The request body is invalid.', {
        ...(failure.path !== undefined ? { param: failure.path } : {}),
      }),
    );
  }

  return ok(route, body as Record<string, unknown>, req);
}

function checkContentType(
  contentType: string | undefined,
  raw: string,
  route: AcpRouteMatch,
): AcpFailure | undefined {
  if (!route.acceptsBody) return undefined;
  if (contentType === undefined) {
    // A POST with no body at all (a bare cancel) needs no content type.
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
): AcpGuardResult {
  const requestId = normalizeRequestId(header(req, ACP_REQUEST_ID_HEADER));
  return {
    ok: true,
    value: { route, body, ...(requestId !== undefined ? { requestId } : {}) },
  };
}

function failed(failure: AcpFailure): AcpGuardResult {
  return { ok: false, ...failure };
}

/**
 * The caller's correlation id, echoed back but never used as the gateway's own
 * request identity. It is attacker-controlled text on its way into a response
 * header, so it is bounded and reduced to visible ASCII - a newline in there is
 * a response-splitting attempt, not a correlation id.
 */
export function normalizeRequestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().slice(0, ACP_MAX_REQUEST_ID_LENGTH);
  if (trimmed.length === 0) return undefined;
  if (/[^\x20-\x7e]/.test(trimmed)) return undefined;
  return trimmed;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the unconsumed request stream the gateway hands over, stopping at the
 * cap rather than buffering whatever arrives.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) return { kind: 'too-large' };
      chunks.push(buffer);
    }
  } catch {
    return { kind: 'unreadable' };
  }
  return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') };
}

/** A result object, not a sentinel string: a body whose text *is* "too-large" is a body. */
type BodyRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'unreadable' };
