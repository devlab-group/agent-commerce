function viteEnv(name: string): string | undefined {
  return (import.meta as { env?: Record<string, string | undefined> }).env?.[name];
}

/** Gateway base URL. `VITE_GATEWAY_URL` (see docker-compose.yml), defaulting to the local dev gateway */
export function getGatewayUrl(): string {
  return (viteEnv('VITE_GATEWAY_URL') ?? 'http://localhost:8080').replace(/\/$/, '');
}

/**
 * Admin token for the operator routes the dashboard reads (`/api/receipts`,
 * `/api/events`), sent as `Authorization: Bearer <token>`. Undefined when
 * unset. The gateway answers those routes with 404 when it has no token
 * configured and 401 when the token is missing or wrong.
 *
 * SECURITY: every browser that loads the dashboard receives this token. Vite
 * inlines `VITE_`-prefixed variables into the JavaScript it serves, and the
 * dynamic lookup in `viteEnv` inlines the whole `import.meta.env` object.
 * SECURITY.md ("Which routes are authenticated") explains why the demo
 * accepts this and a real `server.adminToken` must never be set here.
 */
export function getAdminToken(): string | undefined {
  return viteEnv('VITE_ADMIN_TOKEN');
}
