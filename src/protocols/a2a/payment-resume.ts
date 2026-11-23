// Completing a purchase that waits for an x402 extension payment, from the follow-up message that pays or declines it
import type { AuthorizationSubmission, CanonicalRequest, ProtocolAdapterContext } from '../../core';
import { CommerceError, toCommerceError } from '../../core';
import { toLogInfo } from '../../core/errors';
import { isRecord } from '../../core/is-record';
import type { BackgroundRuns } from './background';
import { A2A_TASK_STATE_FAILED } from './constants';
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  type JsonRpcId,
  jsonRpcError,
  jsonRpcResult,
  retryInfo,
} from './jsonrpc';
import {
  chargedNothing,
  completedTask,
  failedTask,
  type TaskIdentity,
  withStatusMessage,
  workingTask,
} from './task-mapping';
import type { A2aTask } from './types';
import {
  type PendingPayment,
  type PendingPayments,
  paymentCompletedMetadata,
  paymentFailureMetadata,
  paymentRejectedMetadata,
  readFollowUpAuthorization,
  readPaymentSubmission,
  X402_PAYMENT_ERROR_KEY,
  X402_PAYMENT_PAYLOAD_KEY,
  X402_PAYMENT_STATUS_KEY,
} from './x402-extension';

/** A2A's JSON-RPC result wraps the terminal task */
export function taskResult(id: JsonRpcId, task: A2aTask): Record<string, unknown> {
  return jsonRpcResult(id, { task });
}

/** Adapter state used to process a payment follow-up */
export interface PaymentResume {
  readonly context: ProtocolAdapterContext;
  readonly pendingPayments: PendingPayments;
  /**
   * Retain the response with its eviction flag. Log write failures and
   * return false instead of throwing.
   */
  readonly keep: (task: A2aTask, evictable: boolean) => Promise<boolean>;
  /** Active task ids, including blocking payments and background runs */
  readonly running: Set<string>;
  readonly background: BackgroundRuns;
  /** Store a working response; return an error if the write fails */
  readonly recordWorking: (task: A2aTask) => Promise<CommerceError | undefined>;
}

/** Refusal message when no background slot is free */
export const BACKGROUND_FULL = 'Too many tasks are running in the background; retry shortly.';

// Seconds a payment refused for want of a background slot waits before a resend
const BACKGROUND_RETRY_SECONDS = 1;

/**
 * Resume an unpaid x402 task identified by `taskId`, even without the extension
 * header. Return undefined if the message names no pending task or loses the
 * atomic take to another call. Call after `readMessage` validates the message.
 * For a payment submission with `returnImmediately`, return a working task
 * without waiting for the payment result.
 */
export async function resumePayment(
  resume: PaymentResume,
  id: JsonRpcId,
  params: unknown,
  returnImmediately: boolean,
): Promise<Record<string, unknown> | undefined> {
  const { context, pendingPayments } = resume;
  const message = isRecord(params) ? params['message'] : undefined;
  const taskId = isRecord(message) ? message['taskId'] : undefined;
  if (typeof taskId !== 'string') return undefined;
  const pending = await pendingPayments.get(taskId);
  if (pending === undefined) return undefined;

  // Reject a mismatched context without consuming the pending task
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
  // Reserve capacity before taking the purchase so a full runner leaves it
  // payable. Refuse with a system error, not a failed task: a terminal state
  // would tell the client the task takes no more messages (A2A 1.0.1
  // sections 3.1.1 and 3.3.2).
  const immediate = returnImmediately && submission.kind === 'submitted';
  if (immediate && !resume.background.reserve()) {
    return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, BACKGROUND_FULL, [
      retryInfo(BACKGROUND_RETRY_SECONDS),
    ]);
  }
  // The earlier read did not claim the purchase. Take it after validation,
  // before execution; if another call won, use the retained task response.
  let taken: PendingPayment | undefined;
  try {
    taken = await pendingPayments.take(taskId);
  } finally {
    // An empty or failed take must release the reserved background slot
    if (immediate && taken === undefined) resume.background.release();
  }
  if (taken === undefined) return undefined;
  const authorization = taken.authorization ?? followUp;

  if (submission.kind === 'rejected') {
    const timestamp = context.clock.nowIso();
    const declined = withStatusMessage(
      {
        id: taskId,
        contextId: taken.contextId,
        status: { state: A2A_TASK_STATE_FAILED, timestamp },
        artifacts: [],
      },
      'Payment was declined.',
      context.ids.next('a2a-msg'),
      paymentRejectedMetadata(),
    );
    await resume.keep(declined, true);
    return taskResult(id, declined);
  }

  const ids = {
    taskId,
    contextId: taken.contextId,
    artifactId: context.ids.next('a2a-artifact'),
    statusMessageId: context.ids.next('a2a-msg'),
  };
  const working = workingTask(taskId, taken.contextId, context.clock.nowIso());
  // Add the running entry before publishing the working record
  resume.running.add(taskId);
  if (!immediate) {
    await resume.keep(working, false);
  } else {
    // Require a working record before background payment processing. The
    // purchase has been taken, but payment verification has not started.
    const refused = await resume.recordWorking(working);
    if (refused !== undefined) {
      resume.running.delete(taskId);
      resume.background.release();
      // Verification has not started, so this failure is uncharged and evictable
      const failed = failedTask(refused, { ...ids, timestamp: context.clock.nowIso() });
      await resume.keep(failed, true);
      return taskResult(id, failed);
    }
  }
  const pay = async (): Promise<A2aTask> => {
    try {
      const { task: paid, evictable } = await payPending(
        context,
        { ...taken, ...(authorization !== undefined ? { authorization } : {}) },
        submission.payload,
        ids,
      );
      await resume.keep(paid, evictable);
      return paid;
    } finally {
      resume.running.delete(taskId);
    }
  };
  if (!immediate) return taskResult(id, await pay());
  resume.background.start(pay);
  return taskResult(id, working);
}

// The pending purchase is consumed before execution; resends to a retained
// task get UnsupportedOperationError. Omit the retry delay so the client can
// start a new task with the same payment id.
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

// Execute the submitted x402 PaymentPayload and timestamp the task when
// processing ends. Mark it evictable only when this request charged nothing.
async function payPending(
  context: ProtocolAdapterContext,
  pending: PendingPayment,
  payload: Record<string, unknown>,
  ids: Omit<TaskIdentity, 'timestamp'>,
): Promise<{ readonly task: A2aTask; readonly evictable: boolean }> {
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
      const identity = { ...ids, timestamp: context.clock.nowIso() };
      const task = withStatusMessage(
        completedTask(outcome, identity),
        'Payment settled.',
        identity.statusMessageId,
        paymentCompletedMetadata(outcome.payment),
      );
      return { task, evictable: false };
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
  const identity = { ...ids, timestamp: context.clock.nowIso() };
  const metadata = paymentFailureMetadata(error, pending.network);
  const reason = error.details?.['reason'];
  let text: string;
  if (metadata[X402_PAYMENT_STATUS_KEY] === 'payment-completed') {
    text = 'Payment settled, but the resource could not be delivered.';
  } else if (typeof reason === 'string' && reason.startsWith('payment_identifier_')) {
    // Retry-key refusals make no new charge; show the specific error message
    text = error.message;
  } else {
    // Show the metadata's failure reason in the status text (a2a-x402 v0.1 §8)
    const outcome = error.code.startsWith('PAYMENT_')
      ? 'Payment failed'
      : 'The resource could not be delivered';
    text = `${outcome}: ${String(metadata[X402_PAYMENT_ERROR_KEY])}.`;
  }
  return {
    task: withStatusMessage(failedTask(error, identity), text, identity.statusMessageId, metadata),
    evictable: chargedNothing(error, true),
  };
}
