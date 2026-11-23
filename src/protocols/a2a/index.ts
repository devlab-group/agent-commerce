/**
 * src/protocols/a2a
 *
 * A2A (Agent2Agent) v1 adapter. Publishes canonical resources as A2A skills at
 * `/.well-known/agent-card.json` and serves JSON-RPC at its configured mount.
 * See `descriptor.ts` for unsupported features.
 */

export type { A2aAdapterOptions } from './adapter';
export { createA2aAdapter } from './adapter';
export { A2A_AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, A2A_SPEC_VERSION } from './constants';
