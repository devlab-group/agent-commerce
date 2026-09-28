import { useCallback, useEffect, useState } from 'react';
import { EventFeed } from './components/EventFeed';
import { ReceiptList } from './components/ReceiptList';
import { ResourceList } from './components/ResourceList';
import { StatusPanel } from './components/StatusPanel';
import { fetchReceipts, fetchResources, fetchWellKnown } from './lib/api';
import { getGatewayUrl } from './lib/config';
import { pollEvents } from './lib/event-poll';
import type {
  CommerceEvent,
  CommerceReceipt,
  PublicResource,
  WellKnownDocument,
} from './lib/types';

const WELL_KNOWN_REFRESH_MS = 10_000;
const MAX_EVENTS_IN_STATE = 200;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const gatewayUrl = getGatewayUrl();

  const [resources, setResources] = useState<readonly PublicResource[]>([]);
  const [resourcesError, setResourcesError] = useState<string>();

  const [wellKnown, setWellKnown] = useState<WellKnownDocument>();
  const [wellKnownError, setWellKnownError] = useState<string>();

  const [receipts, setReceipts] = useState<readonly CommerceReceipt[]>([]);
  const [receiptsError, setReceiptsError] = useState<string>();

  const [events, setEvents] = useState<readonly CommerceEvent[]>([]);
  const [eventsAuthError, setEventsAuthError] = useState<string>();

  const [highlightRequestId, setHighlightRequestId] = useState<string>();

  const toggleHighlight = useCallback((requestId: string) => {
    setHighlightRequestId((current) => (current === requestId ? undefined : requestId));
  }, []);

  const refreshReceipts = useCallback(() => {
    fetchReceipts(gatewayUrl)
      .then((r) => {
        setReceipts(r);
        setReceiptsError(undefined);
      })
      .catch((err: unknown) => setReceiptsError(errorMessage(err)));
  }, [gatewayUrl]);

  useEffect(() => {
    fetchResources(gatewayUrl)
      .then((r) => {
        setResources(r);
        setResourcesError(undefined);
      })
      .catch((err: unknown) => setResourcesError(errorMessage(err)));
  }, [gatewayUrl]);

  useEffect(() => {
    let canceled = false;
    const refresh = (): void => {
      fetchWellKnown(gatewayUrl)
        .then((doc) => {
          if (!canceled) {
            setWellKnown(doc);
            setWellKnownError(undefined);
          }
        })
        .catch((err: unknown) => {
          if (!canceled) setWellKnownError(errorMessage(err));
        });
    };
    refresh();
    const interval = setInterval(refresh, WELL_KNOWN_REFRESH_MS);
    return () => {
      canceled = true;
      clearInterval(interval);
    };
  }, [gatewayUrl]);

  useEffect(() => {
    refreshReceipts();
  }, [refreshReceipts]);

  useEffect(
    () =>
      pollEvents(
        gatewayUrl,
        (event) => {
          setEvents((current) => [event, ...current].slice(0, MAX_EVENTS_IN_STATE));
          if (event.type === 'resource.delivered') refreshReceipts();
        },
        {
          onAuthError: setEventsAuthError,
          onPollSucceeded: () => setEventsAuthError(undefined),
        },
      ),
    [gatewayUrl, refreshReceipts],
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>Agent Commerce demo dashboard</h1>
        <p>
          Read-only view of <code>{gatewayUrl}</code>. Run <code>npm run demo:agent</code> and watch
          the same request land here.
        </p>
      </header>

      {resourcesError !== undefined ? (
        <ResourceList resources={[]} error={resourcesError} />
      ) : (
        <ResourceList resources={resources} />
      )}

      {wellKnownError !== undefined ? (
        <StatusPanel error={wellKnownError} />
      ) : (
        <StatusPanel {...(wellKnown !== undefined ? { wellKnown } : {})} />
      )}

      <EventFeed
        events={events}
        {...(highlightRequestId !== undefined ? { highlightRequestId } : {})}
        {...(eventsAuthError !== undefined ? { authError: eventsAuthError } : {})}
        onSelectRequestId={toggleHighlight}
      />

      {receiptsError !== undefined ? (
        <ReceiptList receipts={[]} error={receiptsError} onSelectRequestId={toggleHighlight} />
      ) : (
        <ReceiptList
          receipts={receipts}
          {...(highlightRequestId !== undefined ? { highlightRequestId } : {})}
          onSelectRequestId={toggleHighlight}
        />
      )}
    </div>
  );
}
