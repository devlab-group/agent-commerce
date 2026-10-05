/**
 * Execution outcome -> ACP response, under two rules. A successful answer must
 * be a document the pinned snapshot accepts, on the status ACP fixes for the
 * route, because a merchant backend is not automatically ACP-conformant. A
 * failure uses ACP's error shape. Only selected fields of a valid merchant
 * ACP error and a capped `Retry-After` delay can cross this boundary; internal
 * details stay in logs.
 */
import type { CommerceError, DeliveredOutcome } from '../../core';
import { BackendErrorResponse } from '../../core/execution/backend-http';
import { isRecord } from '../../core/is-record';
import {
  ACP_MERCHANT_RETRY_AFTER_DEFAULT_SECONDS,
  ACP_MERCHANT_RETRY_AFTER_MAX_SECONDS,
  type AcpCheckoutOperation,
} from './constants';
import { type AcpErrorType, type AcpFailure, acpFailure } from './errors';
import { type AcpDefinition, validateAcpDocument } from './validation';

/** One ACP answer, as a value: it may have to be stored before it is written */
export interface AcpResponse {
  readonly status: number;
  readonly body: unknown;
  /** True when this answer came from the idempotency store rather than work done now */
  readonly replayed?: boolean;
  /**
   * Seconds for `Retry-After`, set only where a retry is the right move. Not
   * derived from the status: two of the 409s this adapter returns must not
   * invite a retry.
   */
  readonly retryAfterSeconds?: number;
}

/**
 * The status each route answers on success, fixed by ACP. A merchant backend
 * that succeeded with a different one has not implemented the operation ACP
 * describes, so its answer is refused rather than quietly renumbered.
 */
export const ACP_SUCCESS_STATUS: Readonly<Record<AcpCheckoutOperation, number>> = {
  createCheckoutSession: 201,
  updateCheckoutSession: 200,
  getCheckoutSession: 200,
  completeCheckoutSession: 200,
  cancelCheckoutSession: 200,
};

/**
 * A mapped response, plus what the operator needs in the log to understand a
 * refusal. `logDetail` is kept apart from `response` so it never reaches the
 * client.
 */
export interface AcpMappedResponse {
  readonly response: AcpResponse;
  readonly logDetail?: Readonly<Record<string, unknown>>;
}

const PROCESSING_ERROR = acpFailure(
  500,
  'processing_error',
  'processing_error',
  'The server could not process this checkout operation.',
);

export function toAcpResponse(
  operation: AcpCheckoutOperation,
  outcome: DeliveredOutcome,
): AcpMappedResponse {
  const expected = ACP_SUCCESS_STATUS[operation];
  if (outcome.backendStatus !== expected) {
    return {
      response: asResponse(PROCESSING_ERROR),
      logDetail: {
        reason: 'unexpected-backend-status',
        operation,
        backendStatus: outcome.backendStatus,
        expected,
      },
    };
  }

  const definition = responseDefinition(operation, outcome.body);
  const failure = validateAcpDocument(definition, outcome.body);
  if (failure !== undefined) {
    // Not ACP, so not forwarded, and the caller learns nothing of its shape:
    // the pointer is into the merchant's document, ours to fix, not theirs
    return {
      response: asResponse(PROCESSING_ERROR),
      logDetail: {
        reason: 'backend-response-not-acp',
        operation,
        definition,
        path: failure.path ?? '$',
        keyword: failure.code,
      },
    };
  }

  const htmlPath = rawHtmlPath(outcome.body, '$');
  if (htmlPath !== undefined) {
    // Reject detected HTML markup before forwarding merchant markdown
    return {
      response: asResponse(PROCESSING_ERROR),
      logDetail: { reason: 'backend-markdown-has-raw-html', operation, path: htmlPath },
    };
  }

  return { response: { status: expected, body: outcome.body } };
}

// Detect common HTML markup: tags, comments, processing instructions,
// declarations and CDATA. Autolinks such as <https://x> do not match.
const RAW_HTML = /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[/;

// Ignore backtick-delimited code spans when checking for HTML markup
const CODE_SPAN = /(`+)[\s\S]*?\1/g;

// Path to the first markdown `content` with detected HTML markup
function rawHtmlPath(node: unknown, path: string): string | undefined {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const found = rawHtmlPath(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  const content = node['content'];
  if (
    node['content_type'] === 'markdown' &&
    typeof content === 'string' &&
    RAW_HTML.test(content.replace(CODE_SPAN, ''))
  ) {
    return `${path}.content`;
  }
  for (const [key, value] of Object.entries(node)) {
    const found = rawHtmlPath(value, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Completion is the one route with two shapes, chosen by the session's own
 * `status`. A completed session must carry its order
 * (`CheckoutSessionWithOrder`, where `Order` requires an id), but a completion
 * that ends in a declined payment or an out-of-stock item answers 200 with an
 * ordinary session and no order, as the snapshot's own examples show.
 */
function responseDefinition(operation: AcpCheckoutOperation, body: unknown): AcpDefinition {
  if (operation !== 'completeCheckoutSession') return 'checkoutSession';
  const status = (body as { status?: unknown } | null)?.status;
  return status === 'completed' ? 'checkoutSessionWithOrder' : 'checkoutSession';
}

/**
 * Map pipeline failures to ACP errors. For relayed merchant statuses, a
 * valid ACP error can contribute its type, safe code and optional param. The
 * merchant's message and remaining body fields stay out of the response.
 */
export function mapCommerceErrorToAcp(
  error: CommerceError,
  operation: AcpCheckoutOperation,
): AcpFailure {
  switch (error.code) {
    case 'INPUT_INVALID':
      // The ACP schema accepted the document, so the resource's own input
      // schema rejected it: reported without naming its internal fields
      return acpFailure(
        400,
        'invalid_request',
        'invalid_request_body',
        'The request could not be accepted for this checkout operation.',
      );
    case 'BACKEND_TIMEOUT':
      return acpFailure(
        504,
        'service_unavailable',
        'service_unavailable',
        'The merchant did not respond in time.',
      );
    case 'GATEWAY_BUSY':
      return acpFailure(
        503,
        'service_unavailable',
        'service_unavailable',
        'The gateway is busy; retry shortly.',
      );
    case 'BACKEND_ERROR':
      return fromBackendStatus(error, operation);
    default:
      // RESOURCE_NOT_FOUND means the mapping points at a resource that is gone;
      // a PAYMENT_* code means a checkout resource was configured as paid.
      // Both are broken deployments, not something the caller did.
      return PROCESSING_ERROR;
  }
}

/**
 * Relay compatible merchant statuses and map merchant 429/503 to ACP 503.
 * Merchant 401/403 maps to 502 so it does not suggest the agent's bearer
 * token failed.
 */
function fromBackendStatus(error: CommerceError, operation: AcpCheckoutOperation): AcpFailure {
  const failure = statusFailure(error, operation);
  return failure.status < 500 ? withMerchantError(failure, error) : failure;
}

/** True for merchant 429, which the adapter treats as unprocessed */
export function isMerchantRateLimit(error: CommerceError): boolean {
  return error.code === 'BACKEND_ERROR' && error.details?.['status'] === 429;
}

// Parse whole seconds, cap the delay, and use the default for other forms
function merchantRetryAfterSeconds(error: CommerceError): number {
  const value =
    error.cause instanceof BackendErrorResponse ? error.cause.headers['retry-after'] : undefined;
  if (value === undefined || !/^\d{1,9}$/.test(value.trim())) {
    return ACP_MERCHANT_RETRY_AFTER_DEFAULT_SECONDS;
  }
  return Math.min(Math.max(Number(value), 1), ACP_MERCHANT_RETRY_AFTER_MAX_SECONDS);
}

// Limit merchant codes to snake_case and params to short printable text
// beginning with `$`. The `idempotency_` codes describe the caller's own key
// and only the gateway issues them.
const MERCHANT_CODE = /^(?!idempotency_)[a-z][a-z0-9_]{0,63}$/;
const MERCHANT_PARAM = /^\$[\x20-\x7e]{0,255}$/;

/**
 * Keep the type and safe code from a valid merchant ACP error on a relayed
 * status. Include a safe param when present; retain the gateway's message.
 */
function withMerchantError(failure: AcpFailure, error: CommerceError): AcpFailure {
  const body = error.cause instanceof BackendErrorResponse ? error.cause.body : undefined;
  if (!isRecord(body) || validateAcpDocument('error', body) !== undefined) return failure;
  const { type, code, param } = body;
  if (typeof code !== 'string' || !MERCHANT_CODE.test(code)) return failure;
  const relayParam = typeof param === 'string' && MERCHANT_PARAM.test(param) ? param : undefined;
  return acpFailure(
    failure.status,
    type as AcpErrorType,
    code,
    failure.error.message,
    relayParam !== undefined ? { param: relayParam } : {},
  );
}

function statusFailure(error: CommerceError, operation: AcpCheckoutOperation): AcpFailure {
  const merchantStatus = error.details?.['status'];
  const status = typeof merchantStatus === 'number' ? merchantStatus : 0;
  switch (status) {
    case 404:
      return acpFailure(
        404,
        'invalid_request',
        'checkout_session_not_found',
        'No such checkout session.',
      );
    case 405:
      return operation === 'cancelCheckoutSession'
        ? acpFailure(
            405,
            'invalid_request',
            'checkout_session_not_cancelable',
            'This checkout session can no longer be canceled.',
          )
        : acpFailure(
            405,
            'invalid_request',
            'method_not_allowed',
            'The merchant does not allow this operation on this checkout session.',
          );
    case 400:
    case 422:
      // Relayed on the merchant's own status: the snapshot's 3DS refusal is a
      // 400, and its only 422 is the idempotency conflict
      return acpFailure(
        status,
        'invalid_request',
        'invalid_request_body',
        'The merchant rejected this checkout request.',
      );
    case 409:
      return acpFailure(
        409,
        'invalid_request',
        'checkout_session_conflict',
        'This checkout session is in a state that does not allow this operation.',
      );
    case 429:
    case 503:
      return {
        ...acpFailure(
          503,
          'service_unavailable',
          'service_unavailable',
          'The merchant is temporarily unavailable.',
        ),
        retryAfterSeconds: merchantRetryAfterSeconds(error),
      };
    default:
      return acpFailure(
        502,
        'processing_error',
        'processing_error',
        'The merchant could not process this checkout operation.',
      );
  }
}

export function asResponse(failure: AcpFailure): AcpResponse {
  return {
    status: failure.status,
    body: failure.error,
    ...(failure.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
  };
}
