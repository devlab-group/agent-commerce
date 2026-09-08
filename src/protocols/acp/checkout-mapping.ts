/**
 * ACP checkout operation -> canonical request.
 *
 * Each operation maps to exactly one configured resource and one deterministic
 * input envelope, matching `ACP_OPERATION_INPUT_KEYS`: `path` carries
 * `checkout_session_id`, `body` carries the validated ACP document.
 *
 * What is deliberately absent: any synthesis of a payment field. ACP
 * `payment_data` on completion is the merchant's own purchase payment and
 * stays inside `body` as ordinary business input. Turning it into a
 * `PaymentSubmission` would stack a gateway payment on top of the merchant's
 * one, for a single call.
 */
import type { CanonicalRequest } from '../../core/index.js';
import { ACP_OPERATION_INPUT_KEYS } from './constants.js';
import type { AcpGuardedRequest } from './request-guards.js';

export interface AcpCanonicalRequestOptions {
  readonly request: AcpGuardedRequest;
  readonly resourceId: string;
  readonly requestId: string;
  readonly receivedAt: string;
}

export function toCanonicalRequest(options: AcpCanonicalRequestOptions): CanonicalRequest {
  const { request, resourceId, requestId, receivedAt } = options;
  return {
    requestId,
    resourceId,
    input: canonicalInput(request),
    protocol: 'acp',
    receivedAt,
  };
}

function canonicalInput(request: AcpGuardedRequest): Record<string, unknown> {
  const keys = ACP_OPERATION_INPUT_KEYS[request.route.operation];
  const input: Record<string, unknown> = {};

  if (keys.includes('path') && request.route.sessionId !== undefined) {
    input['path'] = { checkout_session_id: request.route.sessionId };
  }
  if (keys.includes('body')) {
    input['body'] = request.body;
  } else if (request.route.acceptsBody && Object.keys(request.body).length > 0) {
    // Cancel: the pinned schema requires no body, so resources are not asked to
    // declare one - but a caller that did send `intent_trace` meant it, and
    // silently dropping it would lose the only thing the request carried.
    input['body'] = request.body;
  }
  return input;
}
