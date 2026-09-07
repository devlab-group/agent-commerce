/**
 * Execution outcome -> ACP response.
 *
 * Two rules run everything here. A successful checkout answer must be a
 * document the pinned snapshot accepts, on the status ACP fixes for that route
 * - a merchant backend is not automatically ACP-conformant, and forwarding
 * whatever it returned would publish its shape as ours. And a failure tells the
 * caller what went wrong in ACP's vocabulary and nothing else: no merchant
 * response body, no stack, no internal path, no database error.
 */
import type { CommerceError, DeliveredOutcome } from '../../core/index.js';
import type { AcpCheckoutOperation } from './constants.js';
import { type AcpFailure, acpFailure } from './errors.js';
import { type AcpDefinition, validateAcpDocument } from './validation.js';

/** One ACP answer, as a value: it may have to be stored before it is written. */
export interface AcpResponse {
  readonly status: number;
  readonly body: unknown;
  /** True when this answer came from the idempotency store rather than work done now. */
  readonly replayed?: boolean;
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
 * A mapped response, plus whatever the operator needs in the log to understand
 * a refusal. `logDetail` never reaches the client - that is the whole point of
 * carrying it separately from `response`.
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
    // The backend document is not ACP. It must not be forwarded, and the
    // caller learns nothing about its shape - the pointer is into the
    // *merchant's* document, which is ours to fix, not theirs.
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
 * Completion is the one route with two shapes.
 *
 * A completed session must carry its order - that is the `CheckoutSessionWithOrder`
 * definition, and `Order` requires an id. But a completion attempt that ends in
 * a declined payment or an out-of-stock line item legitimately answers 200 with
 * an ordinary session and no order (both are examples in the snapshot), so
 * demanding an order on every completion would refuse valid merchant answers.
 * The session's own `status` is what decides which contract applies.
 */
function responseDefinition(operation: AcpCheckoutOperation, body: unknown): AcpDefinition {
  if (operation !== 'completeCheckoutSession') return 'checkoutSession';
  const status = (body as { status?: unknown } | null)?.status;
  return status === 'completed' ? 'checkoutSessionWithOrder' : 'checkoutSession';
}

/**
 * Every failure the pipeline can raise, in ACP's vocabulary.
 *
 * Only the error *code* and, for a backend failure, the backend's *status*
 * cross this boundary. Both are ours to state; the merchant's response body is
 * not, and the gateway already withholds it.
 */
export function mapCommerceErrorToAcp(
  error: CommerceError,
  operation: AcpCheckoutOperation,
): AcpFailure {
  switch (error.code) {
    case 'INPUT_INVALID':
      // The ACP schema accepted the document, so this is the *resource's* input
      // contract rejecting it: a configuration mismatch the caller cannot fix,
      // reported without naming the resource's internal field names.
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
 * A merchant status worth relaying, or a 502.
 *
 * Only statuses that mean the same thing to an ACP client are passed through.
 * A merchant 401 or 403, in particular, is not: relaying it would tell the
 * agent its own bearer token failed, when what failed is the gateway's
 * credential with the backend.
 */
function fromBackendStatus(error: CommerceError, operation: AcpCheckoutOperation): AcpFailure {
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
