/**
 * Two `onRequest` hooks with separate jobs:
 * - `buildAccessControlHook`, registered once on the server: the DNS-rebinding
 * Host check and allowlisted CORS. Neither depends on the path.
 * - `buildOperatorTokenHook`, registered on each operator route (`/api/receipts`,
 * `/api/events`): the `server.adminToken` gate.
 *
 * The token gate is per route because a global hook could only compare
 * `request.url`, which is still percent-encoded, while Fastify's router
 * decodes before matching: `/api/%72eceipts` would pass such a gate and still
 * route to `/api/receipts`. A per-route hook runs only after the router has
 * matched its route, so no path string is compared at all.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AUTHORIZATION_HEADER, PAYMENT_HEADER } from '../core';
import { createBearerCheck } from '../protocols/http';

const CORS_METHODS = 'GET,POST,OPTIONS';
// `authorization` carries bearer tokens (admin, ACP) and MPP credentials; the
// AP2 mandate travels in its own header
const CORS_HEADERS = [
  'content-type',
  PAYMENT_HEADER,
  AUTHORIZATION_HEADER,
  'x-request-id',
  'authorization',
].join(',');
// Cross-origin JS sees only CORS-safelisted response headers unless they are
// named here, so a browser client could read neither the challenge nor the
// settlement result
const CORS_EXPOSED_HEADERS = 'payment-required,payment-response,www-authenticate,payment-receipt';

export interface AccessControlOptions {
  readonly publicBaseUrl: string;
  readonly allowedOrigins: readonly string[];
}

export function buildAccessControlHook(
  options: AccessControlOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  // Matched case-insensitively, like Host, so a mis-cased allowedOrigins entry
  // does not lock out the dashboard. The response echoes the browser's Origin
  // verbatim, because CORS compares it byte for byte.
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => origin.toLowerCase()));
  const publicHostname = hostnameOf(options.publicBaseUrl);

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // 1. Host check (DNS-rebinding defense), for every request
    const host = request.headers.host;
    if (!isAllowedHost(host, publicHostname)) {
      reply.status(403).send({ status: 'error', code: 'FORBIDDEN', message: 'Host not allowed' });
      return;
    }

    // 2. CORS, only for requests carrying an Origin. Agents and MCP clients
    // normally send none and get no CORS headers.
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
        // A preflight carries no credentials, so it is answered here, before
        // any per-route token gate
        reply.status(204).send();
      }
    }
  };
}

/**
 * Per-route `server.adminToken` gate, registered on each operator route's own
 * definition. With no token configured every request gets a 404, as if the
 * route did not exist; a missing or wrong token gets a 401.
 *
 * Header only: a token in a query string leaks through Referer, history and
 * proxy logs.
 */
export function buildOperatorTokenHook(
  adminToken: string | undefined,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const isValidAdminToken = adminToken ? createBearerCheck(adminToken) : undefined;
  // async: Fastify waits for a `done` callback from a hook that returns no
  // Promise, and this one takes none
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isValidAdminToken === undefined) {
      reply.status(404).send();
      return;
    }
    if (!isValidAdminToken(request.headers.authorization)) {
      reply
        .status(401)
        .send({ status: 'error', code: 'UNAUTHORIZED', message: 'Admin token required' });
    }
  };
}

// `new URL()` strips the port and parses IPv6 bracket notation
function hostnameOf(value: string): string {
  try {
    const hostname = new URL(
      value.includes('://') ? value : `http://${value}`,
    ).hostname.toLowerCase();
    // URL#hostname keeps the brackets on an IPv6 literal ("[::1]"); strip them
    // so it compares equal to the plain "::1" form
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  } catch {
    return '';
  }
}

// Loopback names are always accepted, whatever publicBaseUrl says. A
// DNS-rebinding page sends its own hostname as Host, never one of these, and
// local setups often bind 127.0.0.1 while publicBaseUrl says localhost.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isAllowedHost(hostHeader: string | undefined, publicHostname: string): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  return hostname !== '' && (hostname === publicHostname || LOOPBACK_HOSTNAMES.has(hostname));
}
