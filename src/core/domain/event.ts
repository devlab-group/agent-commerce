/**
 * Canonical commerce events. FROZEN CONTRACT. Every event in one flow shares
 * one `requestId`, which correlates logs, payment attempts, backend calls and
 * receipts.
 */
import type { IsoTimestamp } from './common';

export const COMMERCE_EVENT_TYPES = [
  'resource.discovered',
  'resource.requested',
  'payment.required',
  'payment.rejected',
  'payment.verified',
  'payment.settled',
  // The same two types for every authorization method, so an audit-trail
  // reader never has to know what AP2 is
  'authorization.verified',
  'authorization.rejected',
  'backend.called',
  'backend.failed',
  'resource.delivered',
] as const;

export type CommerceEventType = (typeof COMMERCE_EVENT_TYPES)[number];

export interface CommerceEvent {
  readonly id: string;
  readonly type: CommerceEventType;
  readonly requestId: string;
  readonly resourceId?: string;
  readonly at: IsoTimestamp;
  /** Protocol adapter that originated the request, e.g. 'mcp' or 'http' */
  readonly adapter?: string;
  readonly paymentProvider?: string;
  readonly durationMs?: number;
  readonly status?: 'ok' | 'error';
  /** Non-secret, structured detail. Must never contain keys, headers or proofs */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Sink for canonical events. `emit` must not throw: a sink failure must never
 * fail an otherwise successful commerce flow.
 */
export interface EventSink {
  emit(event: CommerceEvent): Promise<void>;
}
