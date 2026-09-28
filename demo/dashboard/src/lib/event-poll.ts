// Event feed: polls `GET /api/events`, sending the admin token as a header
import { fetchEvents as defaultFetchEvents, UnauthorizedError } from './api';
import type { CommerceEvent } from './types';

export interface EventPollDeps {
  readonly fetchEvents?: (gatewayUrl: string) => Promise<readonly CommerceEvent[]>;
  readonly setIntervalFn?: (fn: () => void, ms: number) => number;
  readonly clearIntervalFn?: (handle: number) => void;
  readonly pollIntervalMs?: number;
  /**
   * Called when a poll is rejected for the admin token, so the UI can show an
   * actionable message instead of an empty panel. It can fire on every poll:
   * polling continues, because the gateway's token can be fixed without
   * reloading the dashboard.
   */
  readonly onAuthError?: (message: string) => void;
  /** Called after each successful poll, so the UI can clear an earlier auth error */
  readonly onPollSucceeded?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
// Every poll returns the latest window of events again, so the poller
// remembers the ids it has shown and drops repeats. The cap sits far above
// that window.
const MAX_SEEN_EVENT_IDS = 1000;

/** Polls at once, then on every interval. Returns the function that stops it */
export function pollEvents(
  gatewayUrl: string,
  onEvent: (event: CommerceEvent) => void,
  deps: EventPollDeps = {},
): () => void {
  const fetchEvents = deps.fetchEvents ?? defaultFetchEvents;
  const setIntervalFn =
    deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
  const seen = new Set<string>();

  const poll = (): void => {
    fetchEvents(gatewayUrl)
      .then((events) => {
        deps.onPollSucceeded?.();
        // The gateway answers newest first. Delivering oldest first leaves the
        // newest on top of a feed that prepends each event.
        for (const event of events.toReversed()) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          if (seen.size > MAX_SEEN_EVENT_IDS) {
            for (const oldest of seen) {
              seen.delete(oldest);
              break;
            }
          }
          onEvent(event);
        }
      })
      .catch((err: unknown) => {
        // A missing or rejected token needs the operator; any other failure is
        // retried by the next poll
        if (err instanceof UnauthorizedError) deps.onAuthError?.(err.message);
      });
  };

  poll();
  const timer = setIntervalFn(poll, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  return () => clearIntervalFn(timer);
}
