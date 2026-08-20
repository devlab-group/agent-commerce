/**
 * Thin, typed fetch wrappers over the gateway's read-only HTTP surface
 * (docs/contracts.md). This dashboard never writes anything.
 */
import { getAdminToken } from './config.js';
import type { CommerceEvent, CommerceReceipt, PublicResource, WellKnownDocument } from './types.js';

/**
 * Thrown for the operator ledger routes (receipts/events) when the gateway
 * rejects the request as unauthenticated. Kept
 * distinct from a generic HTTP error so the UI can show an actionable
 * message ("set VITE_ADMIN_TOKEN") instead of a bare status code, and so
 * the event-stream polling fallback can recognise it as non-transient.
 */
export class UnauthorizedError extends Error {
  constructor(url: string) {
    super(
      `${url}: admin token missing or rejected. Set VITE_ADMIN_TOKEN to the gateway's ` +
        'configured server.adminToken to view receipts and events.',
    );
    this.name = 'UnauthorizedError';
  }
}

/** Operator/ledger routes gated behind the admin token (src/gateway/access-control.ts). */
const ADMIN_AUTH_HEADERS: Record<string, string> = (() => {
  const token = getAdminToken();
  return token !== undefined ? { authorization: `Bearer ${token}` } : {};
})();

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, Object.keys(headers).length > 0 ? { headers } : {});
  if (res.status === 401) {
    throw new UnauthorizedError(url);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchResources(gatewayUrl: string): Promise<readonly PublicResource[]> {
  const body = await getJson<{ resources: readonly PublicResource[] }>(
    `${gatewayUrl}/api/resources`,
  );
  return body.resources;
}

export async function fetchWellKnown(gatewayUrl: string): Promise<WellKnownDocument> {
  return getJson<WellKnownDocument>(`${gatewayUrl}/.well-known/agent-commerce`);
}

export async function fetchReceipts(
  gatewayUrl: string,
  limit = 20,
): Promise<readonly CommerceReceipt[]> {
  const body = await getJson<{ receipts: readonly CommerceReceipt[] }>(
    `${gatewayUrl}/api/receipts?limit=${limit}`,
    ADMIN_AUTH_HEADERS,
  );
  return body.receipts;
}

export async function fetchEvents(
  gatewayUrl: string,
  limit = 50,
): Promise<readonly CommerceEvent[]> {
  const body = await getJson<{ events: readonly CommerceEvent[] }>(
    `${gatewayUrl}/api/events?limit=${limit}`,
    ADMIN_AUTH_HEADERS,
  );
  return body.events;
}
