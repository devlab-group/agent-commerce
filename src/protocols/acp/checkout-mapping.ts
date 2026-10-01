/**
 * ACP checkout operation -> canonical request.
 *
 * Each operation maps to one configured resource and one deterministic input
 * envelope: the keys `ACP_OPERATION_INPUT_KEYS` lists, plus any key in
 * `ACP_OPERATION_OPTIONAL_INPUT_KEYS` the caller supplied.
 *
 * No payment field is synthesized. ACP `payment_data` on completion is the
 * merchant's own purchase payment and stays inside `body` as business input;
 * a `PaymentSubmission` built from it would charge a gateway payment on top.
 */
import type { CanonicalRequest } from '../../core';
import { ACP_OPERATION_INPUT_KEYS, ACP_OPERATION_OPTIONAL_INPUT_KEYS } from './constants';
import type { AcpGuardedRequest } from './request-guards';

export interface AcpCanonicalRequestOptions {
  readonly request: AcpGuardedRequest;
  readonly resourceId: string;
  readonly requestId: string;
  readonly receivedAt: string;
  /**
   * Names this checkout operation to the merchant. The adapter derives it from
   * the idempotency scope, so it is the same value on every retry - unlike
   * `requestId`, which is new each time.
   */
  readonly idempotencyKey?: string;
}

export function toCanonicalRequest(options: AcpCanonicalRequestOptions): CanonicalRequest {
  const { request, resourceId, requestId, receivedAt, idempotencyKey } = options;
  return {
    requestId,
    resourceId,
    input: canonicalInput(request),
    protocol: 'acp',
    receivedAt,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function canonicalInput(request: AcpGuardedRequest): Record<string, unknown> {
  const keys = ACP_OPERATION_INPUT_KEYS[request.route.operation];
  const optionalKeys = ACP_OPERATION_OPTIONAL_INPUT_KEYS[request.route.operation] ?? [];
  const input: Record<string, unknown> = {};

  if (keys.includes('path') && request.route.sessionId !== undefined) {
    input['path'] = { checkout_session_id: request.route.sessionId };
  }
  if (keys.includes('body')) {
    input['body'] = request.body;
  } else if (optionalKeys.includes('body') && Object.keys(request.body).length > 0) {
    input['body'] = request.body;
  }
  return input;
}
