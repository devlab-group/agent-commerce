/**
 * The five stable checkout routes, matched against the adapter's mount.
 *
 * The route table is closed: anything else under the mount is a 404, so a
 * client cannot discover an unimplemented ACP service by probing paths.
 */
import type { AcpCheckoutOperation } from './constants.js';

/** Longest accepted `checkout_session_id`. Merchant ids are short; this bounds what a caller can send. */
const MAX_SESSION_ID_LENGTH = 128;

/** ACP session ids are opaque, but they are path segments and go into canonical input. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

const COLLECTION = 'checkout_sessions';

export interface AcpRouteMatch {
  readonly operation: AcpCheckoutOperation;
  /** Absent only for `createCheckoutSession`. */
  readonly sessionId?: string;
  /** POST routes carry an ACP request document; the GET route carries none. */
  readonly acceptsBody: boolean;
}

export type AcpRouteResult =
  | { readonly kind: 'match'; readonly route: AcpRouteMatch }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'method-not-allowed'; readonly allow: readonly string[] };

/**
 * Matches `method` + `url` against the checkout routes below `mountPath`.
 *
 * The URL arrives raw from Node, so it still carries any query string and may
 * be percent-encoded; both are handled here rather than by every caller.
 */
export function matchAcpRoute(
  method: string | undefined,
  url: string | undefined,
  mountPath: string,
): AcpRouteResult {
  const segments = routeSegments(url, mountPath);
  if (segments === undefined || segments[0] !== COLLECTION) return { kind: 'not-found' };

  const verb = (method ?? '').toUpperCase();

  // POST /checkout_sessions
  if (segments.length === 1) {
    if (verb !== 'POST') return { kind: 'method-not-allowed', allow: ['POST'] };
    return { kind: 'match', route: { operation: 'createCheckoutSession', acceptsBody: true } };
  }

  const sessionId = segments[1];
  if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) return { kind: 'not-found' };

  // GET|POST /checkout_sessions/{id}
  if (segments.length === 2) {
    if (verb === 'GET') {
      return {
        kind: 'match',
        route: { operation: 'getCheckoutSession', sessionId, acceptsBody: false },
      };
    }
    if (verb === 'POST') {
      return {
        kind: 'match',
        route: { operation: 'updateCheckoutSession', sessionId, acceptsBody: true },
      };
    }
    return { kind: 'method-not-allowed', allow: ['GET', 'POST'] };
  }

  // POST /checkout_sessions/{id}/{complete|cancel}
  if (segments.length === 3) {
    const operation =
      segments[2] === 'complete'
        ? 'completeCheckoutSession'
        : segments[2] === 'cancel'
          ? 'cancelCheckoutSession'
          : undefined;
    if (operation === undefined) return { kind: 'not-found' };
    if (verb !== 'POST') return { kind: 'method-not-allowed', allow: ['POST'] };
    return { kind: 'match', route: { operation, sessionId, acceptsBody: true } };
  }

  return { kind: 'not-found' };
}

/**
 * Path segments below the mount, or `undefined` when the URL is not under it.
 *
 * A percent-encoded separator (`%2F`) is decoded per segment *after* the split,
 * so an id can never smuggle in an extra path segment.
 */
function routeSegments(url: string | undefined, mountPath: string): readonly string[] | undefined {
  if (url === undefined) return undefined;
  const path = url.split('?')[0]?.split('#')[0] ?? '';
  const base = mountPath.replace(/\/+$/, '');
  if (path !== base && !path.startsWith(`${base}/`)) return undefined;

  const rest = path.slice(base.length);
  const segments: string[] = [];
  for (const raw of rest.split('/')) {
    if (raw.length === 0) continue;
    if (raw.length > MAX_SESSION_ID_LENGTH) return undefined;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      // A malformed escape is not a route this adapter serves.
      return undefined;
    }
  }
  return segments;
}
