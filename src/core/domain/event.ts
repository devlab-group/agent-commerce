/**
 * Canonical commerce events.
 *
 * FROZEN CONTRACT. Every event in a single flow shares one `requestId` so that
 * logs, payment attempts, backend calls and receipts are correlatable.
 */
import type { IsoTimestamp } from './common.js';

export const COMMERCE_EVENT_TYPES = [
  'resource.discovered',
  'resource.requested',
  'payment.required',
  'payment.rejected',
  'payment.verified',
  'payment.settled',
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
  /** Protocol adapter that originated the request, e.g. 'mcp' or 'http'. */
  readonly adapter?: string;
  readonly paymentProvider?: string;
  readonly durationMs?: number;
  readonly status?: 'ok' | 'error';
  /** Non-secret, structured detail. Must never contain keys, headers or proofs. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Sink for canonical events.
 *
 * Implementations must be non-throwing from the caller's perspective: an event
 * sink failure must never fail an otherwise successful commerce flow.
 */
export interface EventSink {
  emit(event: CommerceEvent): Promise<void>;
}
