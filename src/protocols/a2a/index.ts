/**
 * src/protocols/a2a
 *
 * A2A (Agent2Agent) v1 adapter, experimental: publishes canonical resources as
 * A2A skills on the specification-fixed Agent Card path and serves the
 * JSON-RPC endpoint at its mount. `descriptor.ts` lists what it does not do.
 */

export type { A2aAdapterOptions } from './adapter';
export { createA2aAdapter } from './adapter';
export { A2A_AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, A2A_SPEC_VERSION } from './constants';
