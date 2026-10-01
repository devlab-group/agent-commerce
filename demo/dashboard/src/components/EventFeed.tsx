import { formatTimestamp, shortenRequestId } from '../lib/format';
import type { CommerceEvent } from '../lib/types';

interface EventFeedProps {
  readonly events: readonly CommerceEvent[];
  readonly highlightRequestId?: string;
  readonly onSelectRequestId?: (requestId: string) => void;
  // Rows shown; `events` may hold more
  readonly maxRows?: number;
  // Set when the gateway rejects the admin token, so the panel says why no events arrive
  readonly authError?: string;
}

const DEFAULT_MAX_ROWS = 50;

/**
 * Polled event feed, newest first and capped. Clicking a row selects its
 * `requestId`, which the receipts panel below highlights too.
 */
export function EventFeed({
  events,
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
        Events <span className="feed-status">Polling</span>
      </h2>
      {authError !== undefined ? <p className="status-fail">{authError}</p> : null}
      {rows.length === 0 ? (
        <p className="empty">
          No events yet. Run <code>npm run demo:agent</code> to generate one.
        </p>
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
                <td>{event.resourceId ?? '-'}</td>
                <td className={event.status === 'error' ? 'status-fail' : undefined}>
                  {event.status ?? '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
