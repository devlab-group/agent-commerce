/**
 * Live event feed connection: `GET /api/events/stream` (SSE), falling back
 * to polling `GET /api/events` when the stream drops, with exponential
 * backoff on reconnection attempts. Every timer and the EventSource
 * constructor itself are injectable so this is fully unit-testable without a
 * real browser EventSource or real timers.
 *
 * The gateway writes named SSE frames
 * (`event: payment.settled\ndata: …`), which the browser `EventSource` API
 * never delivers to `onmessage` — that handler exists only for the default,
 * unnamed `message` type. This client therefore listens on `onmessage` *and*
 * registers `addEventListener` for every `CommerceEventType`, so it works
 * whichever shape the server sends, and a future server-side change (in
 * either direction) can't silently break it again. The polling fallback is
 * also not stopped merely because the connection opens — `onopen` proves
 * nothing about whether frames are actually arriving, which is how a green
 * "live" indicator ends up over a frozen feed. Polling only stops once a frame has genuinely been received.
 */
import { fetchEvents as defaultFetchEvents, UnauthorizedError } from './api.js';
import type { CommerceEvent, CommerceEventType } from './types.js';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

/** Every named SSE event the gateway may write (docs/contracts.md — CommerceEventType). Keep in sync with types.ts. */
const COMMERCE_EVENT_TYPES: readonly CommerceEventType[] = [
  'resource.discovered',
  'resource.requested',
  'payment.required',
  'payment.rejected',
  'payment.verified',
  'payment.settled',
  'backend.called',
  'backend.failed',
  'resource.delivered',
];

/** The subset of the browser `EventSource` API this module needs. */
export interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  /** Needed to receive named SSE events (`event: <type>`) — see module docs. */
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export interface EventStreamDeps {
  readonly createEventSource?: (url: string) => EventSourceLike;
  readonly fetchEvents?: (gatewayUrl: string, limit?: number) => Promise<readonly CommerceEvent[]>;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => number;
  readonly clearTimeoutFn?: (handle: number) => void;
  readonly setIntervalFn?: (fn: () => void, ms: number) => number;
  readonly clearIntervalFn?: (handle: number) => void;
  readonly pollIntervalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /**
   * Fired when polling proves the failure is not transient (the admin token
   * is missing or rejected). Distinct from the
   * status callback so the UI can show an actionable message instead of an
   * empty panel; polling keeps retrying regardless (the token may be fixed
   * and the page not reloaded), so this may fire more than once.
   */
  readonly onAuthError?: (message: string) => void;
}

export interface EventStreamController {
  stop(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 15_000;

export function connectEventStream(
  gatewayUrl: string,
  onEvent: (event: CommerceEvent) => void,
  onStatusChange: (status: StreamStatus) => void,
  deps: EventStreamDeps = {},
): EventStreamController {
  const createEventSource =
    deps.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const fetchEventsImpl = deps.fetchEvents ?? defaultFetchEvents;
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const setIntervalFn =
    deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const initialBackoffMs = deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let stopped = false;
  let source: EventSourceLike | undefined;
  let reconnectTimer: number | undefined;
  let pollTimer: number | undefined;
  let backoffMs = initialBackoffMs;
  /** True once the *current* connection attempt has actually delivered a frame. */
  let frameReceivedThisAttempt = false;
  const seenEventIds = new Set<string>();

  function emit(event: CommerceEvent): void {
    if (seenEventIds.has(event.id)) return;
    seenEventIds.add(event.id);
    onEvent(event);
  }

  function startPolling(): void {
    if (pollTimer !== undefined) return;
    onStatusChange('polling');
    pollTimer = setIntervalFn(() => {
      fetchEventsImpl(gatewayUrl)
        .then((events) => {
          for (const event of events) emit(event);
        })
        .catch((err: unknown) => {
          // A rejected/missing admin token is not transient like a dropped
          // connection: surface it so the UI can show an actionable message
          // instead of a silently empty panel.
          // Any other polling failure stays silent — the reconnect loop
          // driven by the SSE side is the real signal for those.
          if (err instanceof UnauthorizedError) {
            deps.onAuthError?.(err.message);
          }
        });
    }, pollIntervalMs);
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) {
      clearIntervalFn(pollTimer);
      pollTimer = undefined;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    startPolling();
    onStatusChange('reconnecting');
    reconnectTimer = setTimeoutFn(() => {
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      connect();
    }, backoffMs);
  }

  /** Common path for both `onmessage` and every named `addEventListener` — see module docs. */
  function handleFrame(raw: string): void {
    let event: CommerceEvent;
    try {
      event = JSON.parse(raw) as CommerceEvent;
    } catch {
      return; // Malformed frame (e.g. a heartbeat comment surfaced oddly) — ignore, keep streaming.
    }
    if (!frameReceivedThisAttempt) {
      // Proof the stream is actually delivering data, not just open — only
      // now is it safe to stop the polling safety net and claim "live".
      frameReceivedThisAttempt = true;
      backoffMs = initialBackoffMs;
      stopPolling();
      onStatusChange('live');
    }
    emit(event);
  }

  function connect(): void {
    if (stopped) return;
    frameReceivedThisAttempt = false;
    onStatusChange('connecting');
    // Safety net from the very first attempt, not only after an error: an
    // SSE connection that opens but never dispatches a frame we recognise
    // (e.g. a protocol mismatch) must not leave the feed with no fallback.
    startPolling();
    const es = createEventSource(`${gatewayUrl}/api/events/stream`);
    source = es;
    es.onopen = () => {
      // Deliberately does NOT stop polling or report "live": an open
      // connection proves nothing about whether frames are arriving (see
      // module docs). Only `handleFrame` may do that.
    };
    es.onmessage = (ev) => handleFrame(ev.data);
    for (const type of COMMERCE_EVENT_TYPES) {
      es.addEventListener(type, (ev) => handleFrame(ev.data));
    }
    es.onerror = () => {
      es.close();
      source = undefined;
      scheduleReconnect();
    };
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      stopPolling();
      if (reconnectTimer !== undefined) clearTimeoutFn(reconnectTimer);
      source?.close();
    },
  };
}
