/**
 * `@devlab.group/agent-commerce` main entry: the library API. The other entry
 * points are the `agent-commerce` CLI (`src/cli/index.ts`) and one subpath per
 * optional peer set.
 *
 * Each export is deliberate: exporting `*` from internal modules would make
 * every refactor a breaking change. The only wildcard is the frozen contract,
 * `src/core/public-types.ts`, guarded by `npm run check:contract`.
 *
 * Code needing an optional peer lives at a subpath instead: `./mcp` (MCP SDK),
 * `./x402` (the EVM payment stack), `./mpp` (mppx plus that stack) and `./ap2`
 * (JOSE and SD-JWT). Everything reachable from this entry needs only the
 * package's own `dependencies`, so a gateway serving free HTTP resources
 * installs no peer. The A2A and ACP adapters are here because they need no
 * peer.
 */

export type { GatewayConfig } from './config';
// --- configuration ---------------------------------------------------------
export { loadConfig, parseConfig } from './config';
// --- the canonical domain contract ----------------------------------------
// For consumers implementing their own adapter or payment rail
export * from './core/public-types';
export type { GatewayInstance, GatewayOptions } from './gateway';
// --- run a gateway ---------------------------------------------------------
export { createGateway } from './gateway';
// --- the A2A adapter (experimental; no peer dependency) --------------------
export type { A2aAdapterOptions } from './protocols/a2a';
export {
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_SPEC_VERSION,
  createA2aAdapter,
} from './protocols/a2a';
// --- the ACP checkout adapter (experimental; no peer dependency) ------------
export type { AcpAdapterOptions } from './protocols/acp';
export {
  ACP_API_VERSION,
  ACP_SPEC_VERSION,
  ACP_WELL_KNOWN_PATH,
  createAcpAdapter,
} from './protocols/acp';
export {
  createSqliteReceiptStore as receipts,
  createSqliteReceiptStore,
} from './storage/receipts';
