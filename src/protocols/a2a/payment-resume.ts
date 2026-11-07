// Completing a purchase that waits for an x402 extension payment, from the follow-up message that pays or declines it
import type { AuthorizationSubmission, CanonicalRequest, ProtocolAdapterContext } from '../../core';
import { CommerceError, toCommerceError } from '../../core';
import { toLogInfo } from '../../core/errors';
import { isRecord } from '../../core/is-record';
import { A2A_TASK_STATE_FAILED } from './constants';
import { JSONRPC_INVALID_PARAMS, type JsonRpcId, jsonRpcError, jsonRpcResult } from './jsonrpc';
import { userRoleProblem } from './message-mapping';
import { completedTask, failedTask, type TaskIdentity, withStatusMessage } from './task-mapping';
import type { A2aTask } from './types';
import {
  type PendingPayment,
  type PendingPayments,
  paymentCompletedMetadata,
  paymentFailureMetadata,
  paymentRejectedMetadata,
  readFollowUpAuthorization,
  readPaymentSubmission,
  X402_PAYMENT_PAYLOAD_KEY,
  X402_PAYMENT_STATUS_KEY,
} from './x402-extension';

/** A2A's JSON-RPC result wraps the terminal task */
export function taskResult(id: JsonRpcId, task: A2aTask): Record<string, unknown> {
  return jsonRpcResult(id, { task });
}

/**
 * A message on a task waiting for an x402 extension payment, recognized by
 * its `taskId` whether or not the header activated the extension again. Any
 * other task id falls through to `parseInvocation`, which answers TaskNotFoundError.
 */
export async function resumePayment(
  context: ProtocolAdapterContext | undefined,
  pendingPayments: PendingPayments | undefined,
  id: JsonRpcId,
  params: unknown,
): Promise<Record<string, unknown> | undefined> {
  const message = isRecord(params) ? params['message'] : undefined;
  const taskId = isRecord(message) ? message['taskId'] : undefined;
  if (context === undefined || typeof taskId !== 'string') return undefined;
  const pending = await pendingPayments?.get(taskId);
  if (pending === undefined) return undefined;

  const messageId = isRecord(message) ? message['messageId'] : undefined;
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return jsonRpcError(id, JSONRPC_INVALID_PARAMS, 'Message must carry a non-empty "messageId".');
  }
  // Apply the same role check as a new purchase
  const roleProblem = userRoleProblem(isRecord(message) ? message['role'] : undefined);
  if (roleProblem !== undefined) return jsonRpcError(id, JSONRPC_INVALID_PARAMS, roleProblem);
  // Reject a mismatched context without consuming the pending task.
  const contextId = isRecord(message) ? message['contextId'] : undefined;
  if (contextId !== undefined && contextId !== pending.contextId) {
    return jsonRpcError(id, JSONRPC_INVALID_PARAMS, 'Message "contextId" does not match the task.');
  }
  const submission = readPaymentSubmission(message);
  if (submission === undefined) {
    // The task stays pending, so a corrected message can still pay it
    return jsonRpcError(
      id,
      JSONRPC_INVALID_PARAMS,
      `For a pending task, set "${X402_PAYMENT_STATUS_KEY}" to "payment-submitted" and provide a "${X402_PAYMENT_PAYLOAD_KEY}" object, or set it to "payment-rejected".`,
    );
  }
  // An in-memory mandate kept with the purchase takes precedence. A follow-up
  // mandate is checked against the saved resource and input.
  let followUp: AuthorizationSubmission | undefined;
  if (pending.authorization === undefined && submission.kind === 'submitted') {
    try {
      followUp = readFollowUpAuthorization(message);
    } catch (err) {
      return jsonRpcError(id, JSONRPC_INVALID_PARAMS, toCommerceError(err).message);
    }
  }
  // Take only after message validation and before execution. The earlier
  // read did not claim the task; a competing message that loses this take
  // follows the unknown-task path.
  const taken = await pendingPayments?.take(taskId);
  if (taken === undefined) return undefined;
  const authorization = taken.authorization ?? followUp;
  const statusMessageId = context.ids.next('a2a-msg');
  const identity: TaskIdentity = {
    taskId,
    contextId: taken.contextId,
    artifactId: context.ids.next('a2a-artifact'),
    statusMessageId,
    timestamp: context.clock.nowIso(),
  };

  if (submission.kind === 'rejected') {
    const declined: A2aTask = {
      id: taskId,
      contextId: taken.contextId,
      status: { state: A2A_TASK_STATE_FAILED, timestamp: identity.timestamp },
      artifacts: [],
    };
    return taskResult(
      id,
      withStatusMessage(
        declined,
        'Payment was declined.',
        statusMessageId,
        paymentRejectedMetadata(),
      ),
    );
  }
  return taskResult(
    id,
    await payPending(
      context,
      { ...taken, ...(authorization !== undefined ? { authorization } : {}) },
      submission.payload,
      identity,
    ),
  );
}

// The follow-up consumes the task before the pipeline runs; resends get TaskNotFoundError.
// Suppress its retry delay so the client starts a new task with the same payment id.
function withoutRetryDelay(error: CommerceError): CommerceError {
  if (error.details?.['reason'] !== 'payment_identifier_in_flight') return error;
  const { retryAfterSeconds: _delay, ...details } = error.details;
  return new CommerceError(error.code, error.message, {
    httpStatus: error.httpStatus,
    retryable: false,
    details,
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.resourceId !== undefined ? { resourceId: error.resourceId } : {}),
  });
}

// The pending purchase, now with the x402 `PaymentPayload` as its proof
async function payPending(
  context: ProtocolAdapterContext,
  pending: PendingPayment,
  payload: Record<string, unknown>,
  identity: TaskIdentity,
): Promise<A2aTask> {
  const requestId = context.ids.next('a2a');
  const request: CanonicalRequest = {
    requestId,
    resourceId: pending.resourceId,
    input: pending.input,
    protocol: 'a2a',
    receivedAt: context.clock.nowIso(),
    // The same encoding as the HTTP header's base64 PaymentPayload JSON
    payment: {
      method: 'x402',
      payload: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    },
    ...(pending.authorization !== undefined ? { authorization: pending.authorization } : {}),
  };
  let error: CommerceError;
  try {
    const outcome = await context.pipeline.execute(request);
    if (outcome.kind === 'delivered' && outcome.payment !== undefined) {
      return withStatusMessage(
        completedTask(outcome, identity),
        'Payment settled.',
        identity.statusMessageId,
        paymentCompletedMetadata(outcome.payment),
      );
    }
    // A proof was sent, so neither a free delivery nor a new challenge is a
    // payment this task can report
    error = new CommerceError('PAYMENT_INVALID', 'The payment was not accepted.', { requestId });
  } catch (err) {
    error = withoutRetryDelay(toCommerceError(err));
    context.logger.warn(
      { resourceId: pending.resourceId, requestId, err: toLogInfo(error) },
      'a2a adapter: x402 extension payment failed',
    );
  }
  const metadata = paymentFailureMetadata(error, pending.network);
  const reason = error.details?.['reason'];
  let text = 'Payment failed.';
  if (metadata[X402_PAYMENT_STATUS_KEY] === 'payment-completed') {
    text = 'Payment settled, but the resource could not be delivered.';
  } else if (typeof reason === 'string' && reason.startsWith('payment_identifier_')) {
    // Retry-key refusals make no new charge; show the specific error message
    text = error.message;
  } else if (!error.code.startsWith('PAYMENT_')) {
    text = 'The resource could not be delivered.';
  }
  return withStatusMessage(failedTask(error, identity), text, identity.statusMessageId, metadata);
}
