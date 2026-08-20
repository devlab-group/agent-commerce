function viteEnv(name: string): string | undefined {
  return (import.meta as { env?: Record<string, string | undefined> }).env?.[name];
}

/** Gateway base URL. `VITE_GATEWAY_URL` (see docker-compose.yml), defaulting to the local dev gateway. */
export function getGatewayUrl(): string {
  return (viteEnv('VITE_GATEWAY_URL') ?? 'http://localhost:8080').replace(/\/$/, '');
}

/**
 * Shared secret for the operator/ledger routes (`/api/receipts`, `/api/events`,
 * `/api/events/stream`) — sent as `Authorization: Bearer <token>`, matching
 * `src/gateway/access-control.ts`.
 * Undefined when unset; the gateway then answers those routes with 404
 * (no token configured) or 401 (token configured but missing/wrong).
 *
 * SECURITY: this is a *public* value, not a
 * server-side secret. Vite inlines every `VITE_`-prefixed env var into the
 * JavaScript it serves, and this dynamic bracket lookup (`env[name]`, not a
 * static `env.VITE_ADMIN_TOKEN`) makes Vite inline the *entire*
 * `import.meta.env` object rather than just this one key — either way, the
 * token ends up as a literal string in a file any browser loading this
 * dashboard receives. That is only acceptable here because the demo stack
 * binds the dashboard to `127.0.0.1` and ships a non-secret placeholder
 * token. A real `server.adminToken` protecting a merchant's actual ledger
 * must NEVER be shipped to a browser this way — a real deployment needs a
 * server-side session that proxies the ledger routes instead of handing the
 * browser the token directly (post-alpha; not implemented here).
 */
export function getAdminToken(): string | undefined {
  return viteEnv('VITE_ADMIN_TOKEN');
}
