/**
 * SQLite row shapes and their mapping to and from the canonical model. Under
 * `exactOptionalPropertyTypes`, an optional field is set only when present.
 */
import {
  type AuthorizationRecord,
  type CommerceEvent,
  type CommerceEventType,
  type CommerceReceipt,
  type IsoTimestamp,
  type PaymentAttempt,
  type PaymentAttemptResolution,
  type PaymentResult,
  type Transaction,
  transactionState,
} from '../../core';
import { redact } from './redact';

export interface ReceiptRow {
  readonly id: string;
  readonly request_id: string;
  readonly resource_id: string;
  readonly payment_json: string | null;
  readonly delivered_at: string;
  readonly backend_status: number;
  readonly duration_ms: number | null;
  readonly protocol: string | null;
  readonly metadata_json: string | null;
  readonly authorization_json: string | null;
  readonly transaction_id: string | null;
}

export interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly request_id: string;
  readonly resource_id: string | null;
  readonly at: string;
  readonly adapter: string | null;
  readonly payment_provider: string | null;
  readonly duration_ms: number | null;
  readonly status: string | null;
  readonly data_json: string | null;
  readonly transaction_id: string | null;
}

export interface PaymentAttemptRow {
  readonly id: string;
  readonly request_id: string;
  readonly resource_id: string;
  readonly provider: string;
  readonly replay_key: string;
  readonly status: string;
  readonly amount: string;
  readonly currency: string;
  readonly payer: string | null;
  readonly payee: string | null;
  readonly external_reference: string | null;
  readonly rejection_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly transaction_id: string | null;
  readonly resolution_json: string | null;
}

/** A `transactions` row joined with the columns of its payment attempt */
export interface TransactionRow {
  readonly seq: number;
  readonly id: string;
  readonly request_id: string;
  readonly resource_id: string;
  readonly protocol: string;
  readonly provider: string;
  readonly attempt_id: string;
  readonly replay_key: string;
  readonly network: string | null;
  readonly asset: string | null;
  readonly authorization_json: string | null;
  readonly reservation_id: string | null;
  readonly locator_json: string | null;
  readonly expires_at: string | null;
  readonly input_digest: string | null;
  readonly config_digest: string;
  readonly settling_at: string | null;
  readonly backend_dispatched_at: string | null;
  readonly backend_deadline_at: string | null;
  readonly backend_status: number | null;
  readonly backend_error_code: string | null;
  readonly receipt_id: string | null;
  readonly persistence_failures_json: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly payment_status: string;
  readonly payment_amount: string;
  readonly payment_currency: string;
  readonly payment_payee: string | null;
  readonly payment_external_reference: string | null;
}

export function receiptToRow(receipt: CommerceReceipt): {
  id: string;
  request_id: string;
  resource_id: string;
  payment_json: string | null;
  delivered_at: string;
  backend_status: number;
  duration_ms: number | null;
  protocol: string | null;
  metadata_json: string | null;
  authorization_json: string | null;
  transaction_id: string | null;
} {
  return {
    id: receipt.id,
    request_id: receipt.requestId,
    resource_id: receipt.resourceId,
    payment_json: receipt.payment !== undefined ? JSON.stringify(redact(receipt.payment)) : null,
    delivered_at: receipt.deliveredAt,
    backend_status: receipt.backendStatus,
    duration_ms: receipt.durationMs ?? null,
    protocol: receipt.protocol ?? null,
    metadata_json: receipt.metadata !== undefined ? JSON.stringify(redact(receipt.metadata)) : null,
    authorization_json:
      receipt.authorization !== undefined ? JSON.stringify(redact(receipt.authorization)) : null,
    transaction_id: receipt.transactionId ?? null,
  };
}

export function rowToReceipt(row: ReceiptRow): CommerceReceipt {
  const payment =
    row.payment_json !== null ? (JSON.parse(row.payment_json) as PaymentResult) : undefined;
  const metadata =
    row.metadata_json !== null
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : undefined;
  // Null for a receipt written before this column existed and for a resource
  // that requires no authorization
  const authorization =
    row.authorization_json !== null
      ? (JSON.parse(row.authorization_json) as AuthorizationRecord)
      : undefined;
  return {
    id: row.id,
    requestId: row.request_id,
    resourceId: row.resource_id,
    deliveredAt: row.delivered_at,
    backendStatus: row.backend_status,
    ...(payment !== undefined ? { payment } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.protocol !== null ? { protocol: row.protocol } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(authorization !== undefined ? { authorization } : {}),
    ...(row.transaction_id !== null ? { transactionId: row.transaction_id } : {}),
  };
}

export function eventToRow(event: CommerceEvent): {
  id: string;
  type: string;
  request_id: string;
  resource_id: string | null;
  at: string;
  adapter: string | null;
  payment_provider: string | null;
  duration_ms: number | null;
  status: string | null;
  data_json: string | null;
  transaction_id: string | null;
} {
  return {
    id: event.id,
    type: event.type,
    request_id: event.requestId,
    resource_id: event.resourceId ?? null,
    at: event.at,
    adapter: event.adapter ?? null,
    payment_provider: event.paymentProvider ?? null,
    duration_ms: event.durationMs ?? null,
    status: event.status ?? null,
    data_json: event.data !== undefined ? JSON.stringify(redact(event.data)) : null,
    transaction_id: event.transactionId ?? null,
  };
}

export function rowToEvent(row: EventRow): CommerceEvent {
  const data =
    row.data_json !== null ? (JSON.parse(row.data_json) as Record<string, unknown>) : undefined;
  return {
    id: row.id,
    type: row.type as CommerceEventType,
    requestId: row.request_id,
    at: row.at,
    ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
    ...(row.adapter !== null ? { adapter: row.adapter } : {}),
    ...(row.payment_provider !== null ? { paymentProvider: row.payment_provider } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.status !== null ? { status: row.status as 'ok' | 'error' } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(row.transaction_id !== null ? { transactionId: row.transaction_id } : {}),
  };
}

export function rowToPaymentAttempt(row: PaymentAttemptRow): PaymentAttempt {
  return {
    id: row.id,
    requestId: row.request_id,
    resourceId: row.resource_id,
    provider: row.provider,
    replayKey: row.replay_key,
    status: row.status as PaymentAttempt['status'],
    amount: row.amount,
    currency: row.currency,
    ...(row.payer !== null ? { payer: row.payer } : {}),
    ...(row.payee !== null ? { payee: row.payee } : {}),
    ...(row.external_reference !== null ? { externalReference: row.external_reference } : {}),
    ...(row.rejection_reason !== null ? { rejectionReason: row.rejection_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.transaction_id !== null ? { transactionId: row.transaction_id } : {}),
    ...(row.resolution_json !== null
      ? { resolution: JSON.parse(row.resolution_json) as PaymentAttemptResolution }
      : {}),
  };
}

/**
 * Recompute state using `now` so reads reflect backend deadlines that have
 * passed since the last write
 */
export function rowToTransaction(row: TransactionRow, now: IsoTimestamp): Transaction {
  const status = row.payment_status as PaymentAttempt['status'];
  const backend =
    row.backend_dispatched_at !== null && row.backend_deadline_at !== null
      ? {
          dispatchedAt: row.backend_dispatched_at,
          deadlineAt: row.backend_deadline_at,
          ...(row.backend_status !== null ? { status: row.backend_status } : {}),
          ...(row.backend_error_code !== null ? { errorCode: row.backend_error_code } : {}),
        }
      : undefined;
  const completedAt = row.completed_at ?? undefined;
  const authorization =
    row.authorization_json !== null && row.reservation_id !== null
      ? {
          ...(JSON.parse(row.authorization_json) as NonNullable<Transaction['authorization']>),
          reservationId: row.reservation_id,
        }
      : undefined;
  return {
    id: row.id,
    requestId: row.request_id,
    resourceId: row.resource_id,
    protocol: row.protocol as Transaction['protocol'],
    state: transactionState(
      {
        payment: { status },
        ...(backend !== undefined ? { backend } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
      },
      now,
    ),
    payment: {
      provider: row.provider as Transaction['payment']['provider'],
      attemptId: row.attempt_id,
      replayKey: row.replay_key,
      status,
      amount: row.payment_amount,
      currency: row.payment_currency,
      ...(row.network !== null ? { network: row.network } : {}),
      ...(row.asset !== null ? { asset: row.asset } : {}),
      ...(row.payment_payee !== null ? { payee: row.payment_payee } : {}),
      ...(row.payment_external_reference !== null
        ? { externalReference: row.payment_external_reference }
        : {}),
      ...(row.locator_json !== null
        ? { locator: JSON.parse(row.locator_json) as Record<string, unknown> }
        : {}),
      ...(row.settling_at !== null ? { settlingAt: row.settling_at } : {}),
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    },
    ...(authorization !== undefined ? { authorization } : {}),
    ...(backend !== undefined ? { backend } : {}),
    ...(row.receipt_id !== null ? { receiptId: row.receipt_id } : {}),
    ...(row.input_digest !== null ? { inputDigest: row.input_digest } : {}),
    configDigest: row.config_digest,
    ...(row.persistence_failures_json !== null
      ? { persistenceFailures: JSON.parse(row.persistence_failures_json) as string[] }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}
