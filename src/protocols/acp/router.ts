/**
 * The five stable checkout routes, matched against the adapter's mount.
 *
 * The route table is closed: anything else under the mount is a 404, so a
 * client cannot discover an unimplemented ACP service by probing paths.
 */
import type { AcpCheckoutOperation } from './constants';

// Longest raw path segment accepted before decoding, which also bounds
// `checkout_session_id`
const MAX_SEGMENT_LENGTH = 512;

const COLLECTION = 'checkout_sessions';

export interface AcpRouteMatch {
  readonly operation: AcpCheckoutOperation;
  /**
   * The concrete endpoint path, rebuilt from the matched segments rather than
   * taken from the raw URL: it scopes idempotency keys, so it must be one
   * canonical string per endpoint and never carry a query string or an
   * alternative encoding of the same path
   */
  readonly path: string;
  /** Absent only for `createCheckoutSession` */
  readonly sessionId?: string;
  /** POST routes carry an ACP request document; the GET route carries none */
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
    return {
      kind: 'match',
      route: {
        operation: 'createCheckoutSession',
        path: endpointPath(mountPath, segments),
        acceptsBody: true,
      },
    };
  }

  const sessionId = segments[1];
  if (sessionId === undefined || !isSessionId(sessionId)) return { kind: 'not-found' };

  // GET|POST /checkout_sessions/{id}
  if (segments.length === 2) {
    if (verb === 'GET') {
      return {
        kind: 'match',
        route: {
          operation: 'getCheckoutSession',
          path: endpointPath(mountPath, segments),
          sessionId,
          acceptsBody: false,
        },
      };
    }
    if (verb === 'POST') {
      return {
        kind: 'match',
        route: {
          operation: 'updateCheckoutSession',
          path: endpointPath(mountPath, segments),
          sessionId,
          acceptsBody: true,
        },
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
    return {
      kind: 'match',
      route: { operation, path: endpointPath(mountPath, segments), sessionId, acceptsBody: true },
    };
  }

  return { kind: 'not-found' };
}

// Accept decoded merchant ids such as `gid://shop/Checkout/1`. Reject empty
// ids and ASCII control characters.
function isSessionId(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// Re-encode each segment so `/` inside a session id cannot become a route
// separator or a distinct idempotency scope
function endpointPath(mountPath: string, segments: readonly string[]): string {
  return `${mountPath.replace(/\/+$/, '')}/${segments.map(encodeURIComponent).join('/')}`;
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
    if (raw.length > MAX_SEGMENT_LENGTH) return undefined;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      // A malformed escape is not a route this adapter serves
      return undefined;
    }
  }
  return segments;
}
