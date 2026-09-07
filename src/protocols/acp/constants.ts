/**
 * ACP protocol constants shared by the config layer and the adapter.
 *
 * Kept dependency-free: `src/config` reads the operation set at load time, so
 * anything imported here would become a config-load dependency too.
 */

/**
 * The ACP stable snapshot this adapter implements, and the only value accepted
 * in the `API-Version` request header. Both name the same released snapshot;
 * they are separate constants because ACP versions the wire contract and the
 * header independently, and a future snapshot may accept more than one.
 *
 * Changing either means vendoring a new schema directory beside
 * `spec/2026-04-17/` - never editing the vendored one in place.
 */
export const ACP_SPEC_VERSION = '2026-04-17';
export const ACP_API_VERSION = '2026-04-17';

/** Discovery path fixed by the ACP specification - never a configurable mount. */
export const ACP_WELL_KNOWN_PATH = '/.well-known/acp.json';

/**
 * The stable checkout operations, by ACP operation id. All five are required
 * when ACP is enabled: a partially configured checkout lifecycle would be
 * advertised as a whole service the seller cannot actually serve.
 */
export const ACP_CHECKOUT_OPERATIONS = [
  'createCheckoutSession',
  'updateCheckoutSession',
  'getCheckoutSession',
  'completeCheckoutSession',
  'cancelCheckoutSession',
] as const;

export type AcpCheckoutOperation = (typeof ACP_CHECKOUT_OPERATIONS)[number];

/**
 * Top-level canonical-input properties each operation always supplies.
 *
 * `path` carries `{ checkout_session_id }`, `body` the ACP request document.
 * Cancel is deliberately absent a body: the pinned schema does not require
 * one, and inventing one would make every cancel resource declare a property
 * ACP may never fill.
 */
export const ACP_OPERATION_INPUT_KEYS: Readonly<
  Record<AcpCheckoutOperation, readonly ('path' | 'body')[]>
> = {
  createCheckoutSession: ['body'],
  updateCheckoutSession: ['path', 'body'],
  getCheckoutSession: ['path'],
  completeCheckoutSession: ['path', 'body'],
  cancelCheckoutSession: ['path'],
};

/** Media type for every ACP request and response body. */
export const ACP_JSON_MEDIA_TYPE = 'application/json';

/**
 * Protocol headers, lowercased as Node delivers them.
 *
 * `API-Version` is mandatory on checkout requests and is never defaulted:
 * answering an unversioned request as if it named the pinned snapshot would be
 * guessing on the caller's behalf about a contract that changes.
 */
export const ACP_API_VERSION_HEADER = 'api-version';
export const ACP_REQUEST_ID_HEADER = 'request-id';

/**
 * Longest `Request-Id` echoed back. The value is the caller's, so it is
 * bounded and filtered before it is ever written into a response header.
 */
export const ACP_MAX_REQUEST_ID_LENGTH = 128;
