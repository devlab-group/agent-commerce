import type { StreamStatus } from '../lib/event-stream.js';
import { formatTimestamp, shortenRequestId } from '../lib/format.js';
import type { CommerceEvent } from '../lib/types.js';

export interface EventFeedProps {
  readonly events: readonly CommerceEvent[];
  readonly status: StreamStatus;
  readonly highlightRequestId?: string;
  readonly onSelectRequestId?: (requestId: string) => void;
  /** Capped display size — the feed can hold more internally than this shows. */
  readonly maxRows?: number;
  /** Set when the gateway rejects the admin token) — shown instead of a silently empty panel. */
  readonly authError?: string;
}

const DEFAULT_MAX_ROWS = 50;

/**
 * "Polling" reads as its own status, not a degraded one: with an admin token
 * configured, a browser `EventSource` structurally cannot carry it (no
 * custom-header support), so the SSE stream 401s and this client polls
 * `GET /api/events` instead — permanently, by design, not as a fallback
 * waiting to recover (SECURITY.md, "the live event stream is polled, not
 * streamed, when a token is configured";). The same
 * label also covers a genuine transient reconnect after a dropped
 * connection, which is why it doesn't claim a specific cause — "stream
 * down" would be actively wrong in the (common, expected) token-configured
 * case.
 */
function statusLabel(status: StreamStatus): string {
  switch (status) {
    case 'live':
      return 'Live';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'polling':
      return 'Polling';
  }
}

/**
 * Live event feed (`GET /api/events/stream`, SSE) — newest first, capped.
 * Clicking a row selects its `requestId` so a viewer can see the same
 * request correlate across this feed and the receipts panel below.
 */
export function EventFeed({
  events,
  status,
  highlightRequestId,
  onSelectRequestId,
  maxRows,
  authError,
}: EventFeedProps) {
  const limit = maxRows ?? DEFAULT_MAX_ROWS;
  const rows = events.slice(0, limit);

  return (
    <section className="panel">
      <h2>
        Live events <span className="stream-status">{statusLabel(status)}</span>
      </h2>
      {authError !== undefined ? <p className="status-fail">{authError}</p> : null}
      {rows.length === 0 ? (
        <p className="empty">No events yet — try `npm run demo:agent`.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Request</th>
              <th>Resource</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr
                key={event.id}
                className={[
                  event.requestId === highlightRequestId ? 'highlight' : '',
                  onSelectRequestId !== undefined ? 'clickable' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={
                  onSelectRequestId !== undefined
                    ? () => onSelectRequestId(event.requestId)
                    : undefined
                }
                title={event.requestId}
              >
                <td>{formatTimestamp(event.at)}</td>
                <td>{event.type}</td>
                <td>{shortenRequestId(event.requestId)}</td>
                <td>{event.resourceId ?? '—'}</td>
                <td className={event.status === 'error' ? 'status-fail' : undefined}>
                  {event.status ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
