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

// Include the paid offer's network for the rail's replay code. Finished
// attempts get 402 with a fresh challenge; unfinished or unreadable attempts
// keep 409 to avoid prompting a second payment.
export function replayError(error: CommerceError, requirement: PaymentRequirement): CommerceError {
  if (error.code !== 'PAYMENT_REPLAYED') return error;
  const status = error.details?.['attemptStatus'];
  const finished = typeof status === 'string' && FINISHED_ATTEMPT_STATUSES.has(status);
  const network = requirement.network;
  if (!finished && network === undefined) return error;
  return new CommerceError('PAYMENT_REPLAYED', error.message, {
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.resourceId !== undefined ? { resourceId: error.resourceId } : {}),
    ...(finished ? { httpStatus: 402 } : {}),
    details: {
      ...error.details,
      ...(network !== undefined ? { network } : {}),
      ...(finished ? retryChallenge(requirement).details : {}),
    },
  });
}
