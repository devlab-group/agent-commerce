/**
 * Typed domain error codes. FROZEN CONTRACT. Protocol adapters map them into
 * their own response format. Never throw a bare string or untyped Error across
 * an area boundary.
 */
export const COMMERCE_ERROR_CODES = [
  'CONFIG_INVALID',
  'RESOURCE_NOT_FOUND',
  'INPUT_INVALID',
  'PAYMENT_REQUIRED',
  'PAYMENT_INVALID',
  'PAYMENT_REPLAYED',
  'PAYMENT_PROVIDER_UNAVAILABLE',
  'PAYMENT_SETTLEMENT_FAILED',
  'AUTHORIZATION_REQUIRED',
  'AUTHORIZATION_INVALID',
  'AUTHORIZATION_REPLAYED',
  'AUTHORIZATION_PROVIDER_UNAVAILABLE',
  'BACKEND_TIMEOUT',
  'BACKEND_ERROR',
  'PROTOCOL_UNSUPPORTED',
  'GATEWAY_BUSY',
  'STORAGE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

/**
 * Canonical HTTP status for each error code. Every payment failure maps to a
 * 4xx or 5xx status, never to a delivery.
 */
export const COMMERCE_ERROR_HTTP_STATUS: Readonly<Record<CommerceErrorCode, number>> = {
  CONFIG_INVALID: 500,
  RESOURCE_NOT_FOUND: 404,
  INPUT_INVALID: 400,
  PAYMENT_REQUIRED: 402,
  PAYMENT_INVALID: 402,
  PAYMENT_REPLAYED: 409,
  PAYMENT_PROVIDER_UNAVAILABLE: 503,
  PAYMENT_SETTLEMENT_FAILED: 502,
  // 403, not 402: a 402 tells a client to pay and retry, which cannot fix a
  // missing or rejected mandate, and a client that auto-pays on 402 would be
  // charged for a request that was never going to be delivered
  AUTHORIZATION_REQUIRED: 403,
  AUTHORIZATION_INVALID: 403,
  AUTHORIZATION_REPLAYED: 409,
  AUTHORIZATION_PROVIDER_UNAVAILABLE: 503,
  BACKEND_TIMEOUT: 504,
  BACKEND_ERROR: 502,
  PROTOCOL_UNSUPPORTED: 501,
  GATEWAY_BUSY: 503,
  STORAGE_ERROR: 500,
  INTERNAL_ERROR: 500,
};

/** Codes for which a client may reasonably retry the same request */
export const RETRYABLE_ERROR_CODES: ReadonlySet<CommerceErrorCode> = new Set([
  'PAYMENT_PROVIDER_UNAVAILABLE',
  // The verifier or replay store was unreachable, so the mandate got no
  // verdict. The same proof can verify once the outage clears.
  'AUTHORIZATION_PROVIDER_UNAVAILABLE',
  'BACKEND_TIMEOUT',
  // Load shedding is transient: the caller should back off and try again.
  // Clients act on this flag, and leaving it out would make a momentary
  // throttle look like a permanent failure.
  'GATEWAY_BUSY',
]);
