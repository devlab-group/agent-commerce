/**
 * `onRequest` hooks doing two separate jobs:
 * - `buildAccessControlHook` (global, registered once): DNS-rebinding Host
 * defence + allowlisted CORS for browser traffic. Neither is path-keyed,
 * so this stays a single hook on the whole server.
 * - `buildOperatorTokenHook` (per-route, registered on each of the three
 * ledger routes individually): the `server.adminToken` gate.
 *
 * Why per-route and not the global hook: a global gate has only
 * `request.url`'s path to match against a literal string set. Fastify's
 * router (find-my-way) percent-*decodes* before matching, so such a gate
 * compares the *raw, still-encoded* string. `/api/%72eceipts` is "not an
 * operator path" to the gate and *is* `/api/receipts` to the router — a full
 * bypass with no precondition beyond network reach. A per-route hook removes
 * the whole bug class rather than guarding one instance of it: Fastify only invokes it
 * once routing has already matched this exact route, so there is no path
 * string left to attack — nothing here compares against `request.url` at
 * all.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const CORS_METHODS = 'GET,POST,DELETE,OPTIONS';
const CORS_HEADERS = 'content-type,payment-signature,x-request-id,authorization';
/**
 * Without this a browser client can read neither the challenge nor the
 * settlement result: cross-origin JS only sees the CORS-safelisted response
 * headers unless they are named here.
 */
const CORS_EXPOSED_HEADERS = 'payment-required,payment-response,x-request-id';

export interface AccessControlOptions {
  readonly publicBaseUrl: string;
  readonly allowedOrigins: readonly string[];
}

export function buildAccessControlHook(
  options: AccessControlOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  // Compare case-insensitively (matches the Host check below) — an
  // operator's mis-cased allowedOrigins entry should not lock out the real
  // dashboard behind a generic 403 with no hint why. The *response* header
  // still echoes the browser's own Origin verbatim (not the lowercased
  // form): CORS requires a byte-for-byte match against what the browser
  // sent, and browsers always send Origin already lowercased in practice, so
  // this loses nothing while fixing the config-typo case.
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => origin.toLowerCase()));
  const publicHostname = hostnameOf(options.publicBaseUrl);

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // 1. Host validation (DNS-rebinding defence) — every request, browser or not.
    const host = request.headers.host;
    if (!isAllowedHost(host, publicHostname)) {
      reply.status(403).send({ status: 'error', code: 'FORBIDDEN', message: 'Host not allowed' });
      return;
    }

    // 2. CORS, only for requests that carry an Origin (browser traffic). A
    // request with no Origin (the normal case for agents/MCP clients) gets no
    // CORS header at all.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin.toLowerCase())) {
        reply
          .status(403)
          .send({ status: 'error', code: 'FORBIDDEN', message: 'Origin not allowed' });
        return;
      }
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-methods', CORS_METHODS);
      reply.header('access-control-allow-headers', CORS_HEADERS);
      reply.header('access-control-expose-headers', CORS_EXPOSED_HEADERS);
      reply.header('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        // Preflight: never carries credentials, so it must not hit a
        // downstream per-route token gate — the browser only sends the real
        // request afterward.
        reply.status(204).send();
      }
    }
  };
}

/**
 * Per-route token gate — register via `{ onRequest: buildOperatorTokenHook(...) }`
 * on each ledger route's own definition, not the global hook. Closed by
 * default: no token configured => 404 (fail closed, indistinguishable from
 * "route doesn't exist"). Token configured but missing/wrong => 401.
 *
 * Header-only, with no exception for the SSE route. `EventSource` cannot send
 * headers, which makes a `?adminToken=` query parameter tempting; the
 * dashboard uses its authenticated polling fallback instead — see
 * SECURITY.md. A token in a query string leaks through Referer, browser
 * history and proxy logs.
 */
export function buildOperatorTokenHook(
  adminToken: string | undefined,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  // async, matching buildAccessControlHook's convention: a plain 2-arg
  // function that returns `void` (not a Promise) is ambiguous to Fastify's
  // hook runner, which otherwise waits on a 3rd `done` callback that never
  // comes.
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!adminToken) {
      reply.status(404).send();
      return;
    }
    if (!isValidAdminToken(request.headers.authorization, adminToken)) {
      reply
        .status(401)
        .send({ status: 'error', code: 'UNAUTHORIZED', message: 'Admin token required' });
    }
  };
}

/** `new URL()` handles port-stripping and IPv6 bracket notation; no need to hand-roll it. */
function hostnameOf(value: string): string {
  try {
    const hostname = new URL(
      value.includes('://') ? value : `http://${value}`,
    ).hostname.toLowerCase();
    // URL#hostname keeps the brackets on an IPv6 literal ("[::1]"); strip them
    // so it compares equal to the plain "::1" form.
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  } catch {
    return '';
  }
}

// Loopback aliases are always trusted regardless of configured publicBaseUrl:
// a DNS-rebinding attacker's page sends its OWN hostname as Host, never the
// literal string "localhost"/"127.0.0.1"/"::1" — so allowing these can never
// reintroduce the attack this check exists to stop, and it keeps local
// dev/test setups (where the bind host and the configured publicBaseUrl
// legitimately differ, e.g. 127.0.0.1 vs. localhost) working without
// requiring them to match exactly.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isAllowedHost(hostHeader: string | undefined, publicHostname: string): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  return hostname !== '' && (hostname === publicHostname || LOOPBACK_HOSTNAMES.has(hostname));
}

function isValidAdminToken(authHeader: string | undefined, adminToken: string): boolean {
  const provided = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : undefined;
  if (provided === undefined) return false;
  // Hash both sides first: timingSafeEqual throws on unequal-length buffers,
  // and a thrown-vs-not branch is itself a timing/type oracle on the token's
  // length. SHA-256 digests are always 32 bytes, so the comparison is
  // constant-shape regardless of what the caller sent.
  return timingSafeEqual(hashToken(provided), hashToken(adminToken));
}

function hashToken(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
