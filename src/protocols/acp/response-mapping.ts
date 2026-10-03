/**
 * Execution outcome -> ACP response, under two rules. A successful answer must
 * be a document the pinned snapshot accepts, on the status ACP fixes for the
 * route, because a merchant backend is not automatically ACP-conformant. A
 * failure uses ACP's error shape. Only selected fields of a valid merchant
 * ACP error can cross this boundary; internal details stay in logs.
 */
import type { CommerceError, DeliveredOutcome } from '../../core';
import { BackendErrorResponse } from '../../core/execution/backend-http';
import { isRecord } from '../../core/is-record';
import type { AcpCheckoutOperation } from './constants';
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

  return { response: { status: expected, body: outcome.body } };
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
 * A merchant status worth relaying, or a 502. Only statuses that mean the same
 * to an ACP client pass through. A merchant 401 or 403 does not: it would tell
 * the agent its own bearer token failed, when the gateway's backend credential
 * did.
 */
function fromBackendStatus(error: CommerceError, operation: AcpCheckoutOperation): AcpFailure {
  const failure = statusFailure(error, operation);
  return failure.status < 500 ? withMerchantError(failure, error) : failure;
}

// Limit merchant codes to snake_case and params to short printable text
// beginning with `$`
const MERCHANT_CODE = /^[a-z][a-z0-9_]{0,63}$/;
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
  const status = error.details?.['status'];
  switch (typeof status === 'number' ? status : 0) {
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
      return acpFailure(
        422,
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
  return { status: failure.status, body: failure.error };
}
