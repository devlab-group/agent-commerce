/**
 * src/protocols/acp
 *
 * ACP (Agentic Commerce Protocol) adapter: serves the stable checkout subset
 * of the pinned `2026-04-17` snapshot at its mount, plus the specification-
 * fixed `/.well-known/acp.json`. Experimental - see `descriptor.ts` for what
 * it does not do, and `spec/` for the vendored schema it validates against.
 */

export type { AcpAdapterOptions } from './adapter.js';
export { AcpProtocolAdapter, createAcpAdapter } from './adapter.js';
export {
  ACP_API_VERSION,
  ACP_API_VERSION_HEADER,
  ACP_CHECKOUT_OPERATIONS,
  ACP_IDEMPOTENCY_KEY_HEADER,
  ACP_IDEMPOTENT_REPLAYED_HEADER,
  ACP_JSON_MEDIA_TYPE,
  ACP_OPERATION_INPUT_KEYS,
  ACP_REQUEST_ID_HEADER,
  ACP_SPEC_VERSION,
  ACP_WELL_KNOWN_PATH,
  type AcpCheckoutOperation,
} from './constants.js';
export { ACP_CAPABILITIES, ACP_UNSUPPORTED } from './descriptor.js';
export type { AcpDiscoveryMetadata } from './discovery.js';
export { buildAcpDiscoveryDocument } from './discovery.js';
export type { AcpError, AcpErrorType, AcpFailure } from './errors.js';
export { identityHash, requestFingerprint } from './idempotency/fingerprint.js';
export {
  ACP_MAX_IDEMPOTENCY_KEY_LENGTH,
  type AcpIdempotencyClaim,
  type AcpIdempotencyScope,
  type AcpIdempotencyStore,
  createAcpIdempotencyStore,
} from './idempotency/store.js';
export type { AcpGuardedRequest, AcpGuardResult } from './request-guards.js';
export { guardAcpRequest } from './request-guards.js';
export type { AcpRouteMatch, AcpRouteResult } from './router.js';
export { matchAcpRoute } from './router.js';
export {
  ACP_DEFINITIONS,
  type AcpDefinition,
  type AcpValidationFailure,
  validateAcpDocument,
} from './validation.js';
