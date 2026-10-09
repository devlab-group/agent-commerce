// What a refused or replayed payment answers with: the unused challenge, when one may be retried
import type { PaymentRequirement } from '../../domain/payment';
import { CommerceError } from '../../errors';

// A refusal leaves this request's challenge unused. Return it with the
// provider's reason so the client can retry without fetching another challenge
export function retryChallenge(
  requirement: PaymentRequirement,
  reason?: string,
): { details?: Record<string, unknown> } {
  const envelope = requirement.challenge.envelope;
  if (envelope === undefined && reason === undefined) return {};
  return {
    details: {
      ...(envelope !== undefined ? { challenge: envelope } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

// Attempt statuses the pipeline treats as finished when handling a replay. The
// legacy `failed` is not one: it recorded any throw from settle(), so it may
// hide a transfer, like `settlement-uncertain`.
const FINISHED_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(['settled', 'rejected']);

// Treat a finished attempt as eligible for a 402 with a new challenge. Keep
// 409 when the first attempt is unfinished or its status is unavailable;
// another challenge could lead to a second payment
export function finishedReplay(
  error: CommerceError,
  requirement: PaymentRequirement,
): CommerceError {
  const status = error.details?.['attemptStatus'];
  if (error.code !== 'PAYMENT_REPLAYED' || typeof status !== 'string') return error;
  if (!FINISHED_ATTEMPT_STATUSES.has(status)) return error;
  return new CommerceError('PAYMENT_REPLAYED', error.message, {
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.resourceId !== undefined ? { resourceId: error.resourceId } : {}),
    httpStatus: 402,
    details: { ...error.details, ...retryChallenge(requirement).details },
  });
}
