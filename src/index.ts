/**
 * `@devlab.group/agent-commerce` — public API.
 *
 * The package ships one product with two entry points: this library surface and
 * the `agent-commerce` CLI (`src/cli/index.ts`). Everything else under `src/` is
 * an internal module, and the boundaries between those modules are enforced by
 * interfaces in `src/core`, not by package manifests.
 *
 * This file is deliberately narrow. Exporting `*` from the internal modules
 * would make every refactor a breaking change for consumers, so each symbol
 * here is a decision. The canonical cross-module contract lives in
 * `src/core/public-types.ts` and is guarded by `npm run check:contract`.
 *
 * **The protocol adapter and the payment provider are not here.** They live at
 * `@devlab.group/agent-commerce/mcp` and `@devlab.group/agent-commerce/x402`, because each needs
 * an optional peer dependency the rest of the package does not: importing
 * keeping them here would make `createGateway` drag in a browser wallet stack
 * and 340 packages. See
 * `src/mcp.ts` and `src/x402.ts`. Everything reachable from *this* entry point
 * needs only the package's own `dependencies`.
 */

export type { GatewayConfig } from './config/index.js';
// --- configuration ---------------------------------------------------------
export { loadConfig, parseConfig } from './config/index.js';
// --- the canonical domain contract ----------------------------------------
// Consumers implementing their own adapter or payment rail need these; they are
// the same frozen surface every internal module codes against.
export * from './core/public-types.js';
export type { GatewayInstance, GatewayOptions } from './gateway/index.js';
// --- run a gateway ---------------------------------------------------------
export { createGateway } from './gateway/index.js';
export {
  createSqliteReceiptStore as receipts,
  createSqliteReceiptStore,
} from './storage/receipts/index.js';
