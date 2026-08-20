import { describe, expect, it } from 'vitest';
import {
  connectEventStream,
  type EventSourceLike,
  type StreamStatus,
} from '../src/lib/event-stream.js';
import type { CommerceEvent } from '../src/lib/types.js';

class FakeEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  readonly url: string;
  private readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Simulates the gateway's real frame shape: `event: <type>\ndata: <payload>`. */
  dispatchNamed(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  close(): void {
    this.closed = true;
  }
}

function makeFakeTimers() {
  let nextId = 1;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  return {
    setTimeoutFn: (fn: () => void): number => {
      const id = nextId++;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeoutFn: (id: number): void => {
      timeouts.delete(id);
    },
    setIntervalFn: (fn: () => void): number => {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearIntervalFn: (id: number): void => {
      intervals.delete(id);
    },
    fireTimeouts(): void {
      const fns = [...timeouts.values()];
      timeouts.clear();
      for (const fn of fns) fn();
    },
    fireIntervals(): void {
      for (const fn of intervals.values()) fn();
    },
    intervalCount(): number {
      return intervals.size;
    },
  };
}

function makeEvent(overrides: Partial<CommerceEvent> = {}): CommerceEvent {
  return {
    id: overrides.id ?? 'e1',
    type: overrides.type ?? 'resource.delivered',
    requestId: overrides.requestId ?? 'req1',
    at: overrides.at ?? '2026-01-01T00:00:00.000Z',
  };
}

function harness(
  overrides: {
    fetchEvents?: () => Promise<readonly CommerceEvent[]>;
    onAuthError?: (message: string) => void;
  } = {},
) {
  const timers = makeFakeTimers();
  const created: FakeEventSource[] = [];
  const received: CommerceEvent[] = [];
  const statuses: StreamStatus[] = [];

  const controller = connectEventStream(
    'http://gw',
    (event) => received.push(event),
    (status) => statuses.push(status),
    {
      createEventSource: (url) => {
        const es = new FakeEventSource(url);
        created.push(es);
        return es;
      },
      fetchEvents: overrides.fetchEvents ?? (async () => []),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      pollIntervalMs: 1000,
      initialBackoffMs: 1000,
      maxBackoffMs: 4000,
      ...(overrides.onAuthError !== undefined ? { onAuthError: overrides.onAuthError } : {}),
    },
  );

  return { controller, timers, created, received, statuses };
}

describe('connectEventStream', () => {
  it('connects to the SSE endpoint under the gateway URL and reports "connecting"', () => {
    const { created, statuses } = harness();
    expect(created).toHaveLength(1);
    expect(created[0]?.url).toBe('http://gw/api/events/stream');
    expect(statuses[0]).toBe('connecting');
  });

  it('does NOT report "live" merely because the stream opens ', () => {
    // `onopen` firing proves nothing about whether frames are actually
    // dispatched — that was exactly how a named-event/onmessage mismatch
    // produced a green "live" indicator over a permanently frozen feed.
    const { created, statuses, timers } = harness();
    created[0]?.onopen?.();
    expect(statuses.at(-1)).not.toBe('live');
    expect(timers.intervalCount()).toBe(1); // the polling safety net stays up
  });

  it('reports "live" once a frame is actually received via onmessage', () => {
    const { created, statuses } = harness();
    created[0]?.onopen?.();
    created[0]?.onmessage?.({ data: JSON.stringify(makeEvent({ id: 'e1' })) });
    expect(statuses.at(-1)).toBe('live');
  });

  it("delivers a named SSE event via addEventListener, matching the gateway's real frame shape", () => {
    // The gateway writes `event: <type>\ndata: …`, which a real EventSource
    // never routes to onmessage. Reproduce that exact delivery path here.
    const { created, received, statuses } = harness();
    created[0]?.onopen?.();
    created[0]?.dispatchNamed('payment.settled', JSON.stringify(makeEvent({ id: 'named-1' })));
    expect(received.map((e) => e.id)).toContain('named-1');
    expect(statuses.at(-1)).toBe('live');
  });

  it('keeps the polling safety net running from the very first connection attempt', () => {
    // If polling only started after an error, a stream that opened but never
    // dispatched a recognised frame would have no fallback at all.
    const { timers } = harness();
    expect(timers.intervalCount()).toBe(1);
  });

  it('delivers a parsed event on message', () => {
    const { created, received } = harness();
    created[0]?.onmessage?.({ data: JSON.stringify(makeEvent({ id: 'e1' })) });
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('e1');
  });

  it('ignores a malformed message instead of throwing', () => {
    const { created, received } = harness();
    expect(() => created[0]?.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it('deduplicates an event already seen (e.g. via SSE, then again via polling)', () => {
    const { created, received } = harness();
    const event = makeEvent({ id: 'dup' });
    created[0]?.onmessage?.({ data: JSON.stringify(event) });
    created[0]?.onmessage?.({ data: JSON.stringify(event) });
    expect(received).toHaveLength(1);
  });

  it('on error: closes the source, starts polling, and reports "reconnecting"', () => {
    const { created, statuses, timers } = harness();
    created[0]?.onerror?.();
    expect(created[0]?.closed).toBe(true);
    expect(statuses).toContain('polling');
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(timers.intervalCount()).toBe(1);
  });

  it('polling picks up events fetched via GET /api/events while the stream is down', async () => {
    const event = makeEvent({ id: 'polled' });
    const { created, received, timers } = harness({ fetchEvents: async () => [event] });
    created[0]?.onerror?.();
    timers.fireIntervals();
    await Promise.resolve(); // flush the fetchEvents().then(...) microtask
    await Promise.resolve();
    expect(received.some((e) => e.id === 'polled')).toBe(true);
  });

  it('reconnects (creates a new EventSource) once the backoff timer fires', () => {
    const { created, timers } = harness();
    created[0]?.onerror?.();
    timers.fireTimeouts();
    expect(created).toHaveLength(2);
  });

  it('keeps polling once the reconnected stream merely opens, only stops once it delivers a frame', () => {
    const { created, timers } = harness();
    created[0]?.onerror?.();
    expect(timers.intervalCount()).toBe(1);
    timers.fireTimeouts();
    created[1]?.onopen?.();
    expect(timers.intervalCount()).toBe(1); // still up: open is not proof of data flowing
    created[1]?.onmessage?.({ data: JSON.stringify(makeEvent()) });
    expect(timers.intervalCount()).toBe(0);
  });

  it('surfaces a rejected/missing admin token from polling via onAuthError, distinct from generic status noise', async () => {
    const { UnauthorizedError } = await import('../src/lib/api.js');
    const authErrors: string[] = [];
    const { created, timers } = harness({
      onAuthError: (message) => authErrors.push(message),
      fetchEvents: async () => {
        throw new UnauthorizedError('http://gw/api/events');
      },
    });
    created[0]?.onerror?.(); // fall onto the polling path
    timers.fireIntervals();
    await Promise.resolve();
    await Promise.resolve();
    expect(authErrors).toHaveLength(1);
    expect(authErrors[0]).toMatch(/admin token/i);
  });

  it('stop() closes the current source and clears pending timers', () => {
    const { created, controller, timers } = harness();
    created[0]?.onerror?.(); // now polling + a pending reconnect timer
    controller.stop();
    expect(created[0]?.closed).toBe(true);
    // A further timeout/interval fire must not create a new EventSource or throw.
    expect(() => {
      timers.fireTimeouts();
      timers.fireIntervals();
    }).not.toThrow();
    expect(created).toHaveLength(1);
  });
});
