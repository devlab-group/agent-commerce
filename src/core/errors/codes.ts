/**
 * Typed domain error codes.
 *
 * FROZEN CONTRACT. Protocol adapters map these codes into their own response
 * format. Never throw a bare string or untyped Error across a package boundary.
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
  'BACKEND_TIMEOUT',
  'BACKEND_ERROR',
  'PROTOCOL_UNSUPPORTED',
  'GATEWAY_BUSY',
  'STORAGE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

/**
 * Canonical HTTP status for each error code.
 *
 * Paid resources fail closed: every payment failure maps to a 4xx/5xx status
 * and never to a successful delivery.
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
  BACKEND_TIMEOUT: 504,
  BACKEND_ERROR: 502,
  PROTOCOL_UNSUPPORTED: 501,
  GATEWAY_BUSY: 503,
  STORAGE_ERROR: 500,
  INTERNAL_ERROR: 500,
};

/** Codes for which a client may reasonably retry the same request. */
export const RETRYABLE_ERROR_CODES: ReadonlySet<CommerceErrorCode> = new Set([
  'PAYMENT_PROVIDER_UNAVAILABLE',
  'BACKEND_TIMEOUT',
  // Load shedding is transient by definition: the caller should back off and
  // try again. Before this code existed the MCP adapter's queue-full path threw
  // PROTOCOL_UNSUPPORTED — HTTP 501, retryable:false — so an agent framework
  // keyed on the machine-readable flag (which exists precisely so clients need
  // not parse prose) would read a momentary throttle as a permanent capability
  // gap and stop calling the tool.
  'GATEWAY_BUSY',
]);
