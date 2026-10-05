/**
 * x402 payment over A2A. The x402 v2 transport puts payment documents in
 * message metadata and resumes an input-required task with a payment message.
 * This adapter uses A2A 1.0 states, roles, parts and extension headers.
 * Clients that do not activate the extension use `_payment` on a new task.
 */
import {
  AUTHORIZATION_INPUT_FIELD,
  type AuthorizationSubmission,
  type Clock,
  type CommerceError,
  type PaymentResult,
  parseAuthorizationSubmission,
} from '../../core';
import { isRecord } from '../../core/is-record';
import {
  settlementFailure,
  settlementResponse,
  settlementResponseFromDetails,
  x402ErrorCode,
} from '../../payments/x402/transport';

/** The URI the x402 A2A transport declares for the extension */
export const A2A_X402_EXTENSION_URI = 'https://github.com/google-a2a/a2a-x402/v0.1';

/** The x402 protocol version of every document the extension carries */
export const A2A_X402_PROTOCOL_VERSION = 2;

export const X402_PAYMENT_STATUS_KEY = 'x402.payment.status';
export const X402_PAYMENT_REQUIRED_KEY = 'x402.payment.required';
export const X402_PAYMENT_PAYLOAD_KEY = 'x402.payment.payload';
export const X402_PAYMENT_RECEIPTS_KEY = 'x402.payment.receipts';
export const X402_PAYMENT_ERROR_KEY = 'x402.payment.error';

// How long an unpaid task waits when the requirement names no expiry, and the
// longest it waits regardless
const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_TTL_MS = 60 * 60 * 1000;

// Bound memory used by unpaid tasks from unauthenticated callers. Each task
// holds one request's input; deployments can raise this cap or use a shared
// store if valid tasks are evicted before payment.
const MAX_PENDING_PAYMENTS = 256;

/** `A2A-Extensions` is a comma-separated URI list, possibly repeated */
export function requestsX402Extension(header: string | readonly string[] | undefined): boolean {
  const values = typeof header === 'string' ? [header] : (header ?? []);
  return values.some((value) =>
    value.split(',').some((uri) => uri.trim() === A2A_X402_EXTENSION_URI),
  );
}

/** A purchase waiting for its payment, held between the two messages */
export interface PendingPayment {
  readonly contextId: string;
  readonly resourceId: string;
  /** Validated by the pipeline again when the payment arrives */
  readonly input: Record<string, unknown>;
  readonly authorization?: AuthorizationSubmission;
  /** Network of the requirement, for a failure receipt whose error names none */
  readonly network?: string;
  readonly expiresAtMs: number;
}

/**
 * Unpaid tasks, in memory and per process. A restart, or a payment routed to
 * another instance, loses the task: the client gets `TaskNotFoundError` before
 * anything is verified or settled, and starts over.
 */
export function createPendingPayments(clock: Clock, maxEntries = MAX_PENDING_PAYMENTS) {
  const tasks = new Map<string, PendingPayment>();
  const now = (): number => clock.now().getTime();

  function purgeExpired(): void {
    const at = now();
    for (const [taskId, pending] of tasks) {
      if (pending.expiresAtMs <= at) tasks.delete(taskId);
    }
  }

  return {
    /** Holds a purchase until `expiresAt`, evicting the oldest one when full */
    put(taskId: string, pending: Omit<PendingPayment, 'expiresAtMs'>, expiresAt?: string): void {
      purgeExpired();
      if (tasks.size >= maxEntries) {
        const [oldest] = tasks.keys();
        if (oldest !== undefined) tasks.delete(oldest);
      }
      const requested = expiresAt !== undefined ? Date.parse(expiresAt) : Number.NaN;
      const ttl = Number.isFinite(requested) ? requested - now() : DEFAULT_PENDING_TTL_MS;
      const expiresAtMs = now() + Math.min(Math.max(ttl, 0), MAX_PENDING_TTL_MS);
      tasks.set(taskId, { ...pending, expiresAtMs });
    },

    get(taskId: string): PendingPayment | undefined {
      const pending = tasks.get(taskId);
      if (pending === undefined) return undefined;
      if (pending.expiresAtMs <= now()) {
        tasks.delete(taskId);
        return undefined;
      }
      return pending;
    },

    delete(taskId: string): void {
      tasks.delete(taskId);
    },

    size(): number {
      return tasks.size;
    },

    clear(): void {
      tasks.clear();
    },
  };
}

export type PendingPayments = ReturnType<typeof createPendingPayments>;

/** What a follow-up message on a pending task asks for */
export type PaymentSubmissionMessage =
  | { readonly kind: 'submitted'; readonly payload: Record<string, unknown> }
  | { readonly kind: 'rejected' };

/** Reads the payment status and payload from a message's metadata */
export function readPaymentSubmission(message: unknown): PaymentSubmissionMessage | undefined {
  const metadata = isRecord(message) ? message['metadata'] : undefined;
  if (!isRecord(metadata)) return undefined;
  const status = metadata[X402_PAYMENT_STATUS_KEY];
  if (status === 'payment-rejected') return { kind: 'rejected' };
  const payload = metadata[X402_PAYMENT_PAYLOAD_KEY];
  if (status === 'payment-submitted' && isRecord(payload)) return { kind: 'submitted', payload };
  return undefined;
}

/**
 * Read `input._authorization` from a payment message. Ignore other input;
 * the task already holds the purchase. Malformed mandates raise
 * `AUTHORIZATION_INVALID`.
 */
export function readFollowUpAuthorization(message: unknown): AuthorizationSubmission | undefined {
  const parts = isRecord(message) ? message['parts'] : undefined;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const data: unknown = isRecord(part) ? part['data'] : undefined;
    const input = isRecord(data) ? data['input'] : undefined;
    if (isRecord(input) && input[AUTHORIZATION_INPUT_FIELD] !== undefined) {
      return parseAuthorizationSubmission(input[AUTHORIZATION_INPUT_FIELD]);
    }
  }
  return undefined;
}

export function paymentRequiredMetadata(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  return {
    [X402_PAYMENT_STATUS_KEY]: 'payment-required',
    [X402_PAYMENT_REQUIRED_KEY]: envelope,
  };
}

export function paymentCompletedMetadata(payment: PaymentResult): Record<string, unknown> {
  return {
    [X402_PAYMENT_STATUS_KEY]: 'payment-completed',
    [X402_PAYMENT_RECEIPTS_KEY]: [settlementResponse(payment)],
  };
}

/**
 * A failure after a payment submission. A backend failure after settlement
 * still reports the payment as completed, with its receipt: the money moved.
 * `network` is the requirement's.
 */
export function paymentFailureMetadata(
  error: CommerceError,
  network?: string,
): Record<string, unknown> {
  const settled = settlementResponseFromDetails(error.details);
  if (settled !== undefined && settled['success'] === true) {
    return {
      [X402_PAYMENT_STATUS_KEY]: 'payment-completed',
      [X402_PAYMENT_RECEIPTS_KEY]: [settled],
    };
  }
  // A backend failure before settlement keeps its own commerce error code.
  const code = error.code.startsWith('PAYMENT_')
    ? x402ErrorCode(error.code, error.details?.['reason'])
    : error.code.toLowerCase();
  const failure = settlementFailure(error.details);
  const receipt =
    failure['network'] === '' && network !== undefined ? { ...failure, network } : failure;
  return {
    [X402_PAYMENT_STATUS_KEY]: 'payment-failed',
    [X402_PAYMENT_ERROR_KEY]: code,
    // Keep the failure reason, including `settlement_pending` when a hash is known
    [X402_PAYMENT_RECEIPTS_KEY]: [
      error.details?.['settlementUncertain'] === true ? receipt : { ...receipt, errorReason: code },
    ],
  };
}

export function paymentRejectedMetadata(): Record<string, unknown> {
  return { [X402_PAYMENT_STATUS_KEY]: 'payment-rejected' };
}
