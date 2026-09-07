/**
 * ACP protocol constants shared by the config layer and the adapter.
 *
 * Kept dependency-free: `src/config` reads the operation set at load time, so
 * anything imported here would become a config-load dependency too.
 */

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
