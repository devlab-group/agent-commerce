/**
 * Execution outcomes as terminal A2A Tasks.
 *
 * A2A models an execution's output as a Task carrying Artifacts, so a
 * completed purchase comes back as one, not as a plain Message, which models
 * conversation.
 *
 * A commerce outcome is never a JSON-RPC error. Payment required, an unknown
 * resource, input the resource schema rejects and a broken backend are all
 * answers, returned as a terminal Task in the JSON-RPC `result`. Only a
 * malformed or unsupported A2A request gets a JSON-RPC error, so a client can
 * tell a refused purchase from a broken gateway.
 *
 * Every artifact payload is an existing canonical envelope, verbatim: there is
 * no A2A-specific delivery, payment-required or error schema.
 */
import {
  type CommerceError,
  DELIVERY_SUMMARY_META_KEY,
  type DeliveredOutcome,
  type PaymentRequiredOutcome,
  toDeliverySummary,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from '../../core';
import { isRecord } from '../../core/is-record';
import {
  A2A_JSON_MEDIA_TYPE,
  A2A_TASK_STATE_COMPLETED,
  A2A_TASK_STATE_FAILED,
  A2A_TASK_STATE_INPUT_REQUIRED,
} from './constants';
import type { A2aArtifact, A2aTask } from './types';

export interface TaskIdentity {
  /** Gateway request id, reused so a task correlates with receipts and events */
  readonly taskId: string;
  /** Fresh for each purchase; a pending x402 payment keeps this context */
  readonly contextId: string;
  readonly artifactId: string;
  readonly timestamp: string;
}

/**
 * A data part's payload must be a JSON object, but a merchant backend may
 * return a string, a number or an array. Those are wrapped under `value`, one
 * predictable rule a caller can code against.
 */
function dataPayload(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : { value: body ?? null };
}

function task(
  identity: TaskIdentity,
  state: string,
  artifact: Omit<A2aArtifact, 'artifactId'>,
): A2aTask {
  return {
    id: identity.taskId,
    contextId: identity.contextId,
    status: { state, timestamp: identity.timestamp },
    artifacts: [{ artifactId: identity.artifactId, ...artifact }],
  };
}

export function completedTask(outcome: DeliveredOutcome, identity: TaskIdentity): A2aTask {
  return task(identity, A2A_TASK_STATE_COMPLETED, {
    name: outcome.resourceId,
    parts: [{ data: dataPayload(outcome.body), mediaType: A2A_JSON_MEDIA_TYPE }],
    // Same meta key MCP attaches its summary under, so a buyer reads the
    // record of their own purchase the same way on either protocol
    metadata: { [DELIVERY_SUMMARY_META_KEY]: { ...toDeliverySummary(outcome) } },
  });
}

/**
 * Without the x402 extension, payment required ends the task. The client
 * starts a new one with `_payment`. With the extension, `inputRequired` keeps
 * this task open for a payment message.
 */
export function paymentRequiredTask(
  outcome: PaymentRequiredOutcome,
  identity: TaskIdentity,
): A2aTask {
  return task(identity, A2A_TASK_STATE_FAILED, {
    name: outcome.resourceId,
    parts: [{ data: { ...toPaymentRequiredEnvelope(outcome) }, mediaType: A2A_JSON_MEDIA_TYPE }],
  });
}

/** The same task waiting for payment, with the extension's metadata on its status message */
export function inputRequired(
  base: A2aTask,
  metadata: Record<string, unknown>,
  messageId: string,
): A2aTask {
  return withStatusMessage(
    { ...base, status: { ...base.status, state: A2A_TASK_STATE_INPUT_REQUIRED } },
    'Payment is required. Send the x402 payment payload on this task.',
    metadata,
    messageId,
  );
}

/** Attaches an agent status message carrying extension metadata */
export function withStatusMessage(
  base: A2aTask,
  text: string,
  metadata: Record<string, unknown>,
  messageId: string,
): A2aTask {
  return {
    ...base,
    status: {
      ...base.status,
      message: { role: 'ROLE_AGENT', messageId, parts: [{ text }], metadata },
    },
  };
}

export function failedTask(error: CommerceError, identity: TaskIdentity): A2aTask {
  return task(identity, A2A_TASK_STATE_FAILED, {
    parts: [{ data: { ...toErrorEnvelope(error) }, mediaType: A2A_JSON_MEDIA_TYPE }],
  });
}
