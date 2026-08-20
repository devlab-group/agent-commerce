/**
 * SQLite row shapes and mapping to/from the canonical domain model.
 *
 * `exactOptionalPropertyTypes` is on: optional fields are only assigned when
 * present (see docs/contracts.md, assumption 8).
 */
import type {
  CommerceEvent,
  CommerceEventType,
  CommerceReceipt,
  PaymentAttempt,
  PaymentResult,
} from '../../core/index.js';
import { redact } from './redact.js';

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
} {
  return {
    id: receipt.id,
    request_id: receipt.requestId,
    resource_id: receipt.resourceId,
    payment_json: receipt.payment !== undefined ? JSON.stringify(redact(receipt.payment)) : null,
    delivered_at: receipt.deliveredAt,
    backend_status: receipt.backendStatus,
    duration_ms: receipt.durationMs !== undefined ? receipt.durationMs : null,
    protocol: receipt.protocol !== undefined ? receipt.protocol : null,
    metadata_json: receipt.metadata !== undefined ? JSON.stringify(redact(receipt.metadata)) : null,
  };
}

export function rowToReceipt(row: ReceiptRow): CommerceReceipt {
  const payment =
    row.payment_json !== null ? (JSON.parse(row.payment_json) as PaymentResult) : undefined;
  const metadata =
    row.metadata_json !== null
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
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
} {
  return {
    id: event.id,
    type: event.type,
    request_id: event.requestId,
    resource_id: event.resourceId !== undefined ? event.resourceId : null,
    at: event.at,
    adapter: event.adapter !== undefined ? event.adapter : null,
    payment_provider: event.paymentProvider !== undefined ? event.paymentProvider : null,
    duration_ms: event.durationMs !== undefined ? event.durationMs : null,
    status: event.status !== undefined ? event.status : null,
    data_json: event.data !== undefined ? JSON.stringify(redact(event.data)) : null,
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
  };
}
