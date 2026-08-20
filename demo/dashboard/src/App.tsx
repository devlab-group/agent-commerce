import { useCallback, useEffect, useState } from 'react';
import { EventFeed } from './components/EventFeed.js';
import { ReceiptList } from './components/ReceiptList.js';
import { ResourceList } from './components/ResourceList.js';
import { StatusPanel } from './components/StatusPanel.js';
import { fetchReceipts, fetchResources, fetchWellKnown } from './lib/api.js';
import { getGatewayUrl } from './lib/config.js';
import { connectEventStream, type StreamStatus } from './lib/event-stream.js';
import type {
  CommerceEvent,
  CommerceReceipt,
  PublicResource,
  WellKnownDocument,
} from './lib/types.js';

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
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
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
    let cancelled = false;
    const refresh = (): void => {
      fetchWellKnown(gatewayUrl)
        .then((doc) => {
          if (!cancelled) {
            setWellKnown(doc);
            setWellKnownError(undefined);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setWellKnownError(errorMessage(err));
        });
    };
    refresh();
    const interval = setInterval(refresh, WELL_KNOWN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gatewayUrl]);

  useEffect(() => {
    refreshReceipts();
  }, [refreshReceipts]);

  useEffect(() => {
    const controller = connectEventStream(
      gatewayUrl,
      (event) => {
        setEvents((current) => [event, ...current].slice(0, MAX_EVENTS_IN_STATE));
        if (event.type === 'resource.delivered') refreshReceipts();
      },
      setStreamStatus,
      { onAuthError: setEventsAuthError },
    );
    return () => controller.stop();
  }, [gatewayUrl, refreshReceipts]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Agent Commerce — Demo Dashboard</h1>
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
        status={streamStatus}
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
