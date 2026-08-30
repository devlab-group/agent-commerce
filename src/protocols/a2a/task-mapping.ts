/**
 * Execution outcomes as terminal A2A Tasks.
 *
 * A2A models the output of an execution as a Task carrying Artifacts, so that
 * is what a completed purchase comes back as — not a plain Message, which
 * models conversation rather than result.
 *
 * The critical split this file enforces: a commerce outcome is never a
 * JSON-RPC error. Payment required, an unknown resource, input that fails the
 * resource schema, a backend that broke — all of those are *answers*, and they
 * come back as a terminal Task in the JSON-RPC `result`. Only a malformed or
 * unsupported A2A request gets a JSON-RPC error. A client that treats a
 * transport failure and a refused purchase the same way is a client that
 * retries a 402 as if the gateway were broken.
 *
 * Every payload inside an artifact is an existing canonical envelope,
 * verbatim. There is no A2A-specific delivery, payment-required or error
 * schema to keep in step with the HTTP and MCP ones.
 */
import {
  type CommerceError,
  DELIVERY_SUMMARY_META_KEY,
  type DeliveredOutcome,
  type PaymentRequiredOutcome,
  toDeliverySummary,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from '../../core/index.js';
import {
  A2A_JSON_MEDIA_TYPE,
  A2A_TASK_STATE_COMPLETED,
  A2A_TASK_STATE_FAILED,
} from './constants.js';
import type { A2aArtifact, A2aTask } from './types.js';

export interface TaskIdentity {
  /** Gateway request id, reused so a task correlates with receipts and events. */
  readonly taskId: string;
  /** Fresh every time: nothing here can be continued, so nothing shares a context. */
  readonly contextId: string;
  readonly artifactId: string;
  readonly timestamp: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A data part's payload must be a JSON object, but a merchant backend may
 * legitimately return a string, a number or an array. Those are wrapped under
 * `value` rather than dropped or stringified — one predictable rule a caller
 * can code against, instead of a shape that depends on what the backend felt
 * like returning.
 */
function dataPayload(body: unknown): Record<string, unknown> {
  return isPlainObject(body) ? body : { value: body ?? null };
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
    // record of their own purchase the same way on either protocol.
    metadata: { [DELIVERY_SUMMARY_META_KEY]: { ...toDeliverySummary(outcome) } },
  });
}

/**
 * Terminal, not `input-required`: without a task store there is nothing to
 * continue, and advertising a resumable task the adapter cannot resume would
 * be worse than saying plainly that this attempt is over. The caller retries
 * by sending a new message carrying the proof.
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

export function failedTask(error: CommerceError, identity: TaskIdentity): A2aTask {
  return task(identity, A2A_TASK_STATE_FAILED, {
    parts: [{ data: { ...toErrorEnvelope(error) }, mediaType: A2A_JSON_MEDIA_TYPE }],
  });
}
