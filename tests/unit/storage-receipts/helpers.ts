import type {
  Clock,
  CommerceEvent,
  CommerceReceipt,
  IdGenerator,
} from '../../../src/core/index.js';

/** Deterministic clock for tests: starts at a fixed instant and ticks 1ms per read. */
export function createFakeClock(startMs = Date.parse('2026-01-01T00:00:00.000Z')): Clock {
  let current = startMs;
  let monotonic = 0;
  return {
    now: () => {
      const d = new Date(current);
      current += 1;
      return d;
    },
    nowIso: () => {
      const iso = new Date(current).toISOString();
      current += 1;
      return iso;
    },
    monotonicMs: () => {
      monotonic += 1;
      return monotonic;
    },
  };
}

export function createFakeIds(): IdGenerator {
  let counter = 0;
  return {
    next: (prefix) => {
      counter += 1;
      return prefix !== undefined ? `${prefix}_${counter}` : `id_${counter}`;
    },
  };
}

export function makeReceipt(overrides: Partial<CommerceReceipt> = {}): CommerceReceipt {
  return {
    id: overrides.id ?? 'receipt_1',
    requestId: overrides.requestId ?? 'req_1',
    resourceId: overrides.resourceId ?? 'resource.weather',
    deliveredAt: overrides.deliveredAt ?? '2026-01-01T00:00:00.000Z',
    backendStatus: overrides.backendStatus ?? 200,
    ...(overrides.payment !== undefined ? { payment: overrides.payment } : {}),
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.protocol !== undefined ? { protocol: overrides.protocol } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

export function makeEvent(overrides: Partial<CommerceEvent> = {}): CommerceEvent {
  return {
    id: overrides.id ?? 'event_1',
    type: overrides.type ?? 'resource.requested',
    requestId: overrides.requestId ?? 'req_1',
    at: overrides.at ?? '2026-01-01T00:00:00.000Z',
    ...(overrides.resourceId !== undefined ? { resourceId: overrides.resourceId } : {}),
    ...(overrides.adapter !== undefined ? { adapter: overrides.adapter } : {}),
    ...(overrides.paymentProvider !== undefined
      ? { paymentProvider: overrides.paymentProvider }
      : {}),
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    ...(overrides.data !== undefined ? { data: overrides.data } : {}),
  };
}
