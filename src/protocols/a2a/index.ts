/**
 * src/protocols/a2a
 *
 * A2A (Agent2Agent) v1 adapter: publishes canonical resources as A2A skills on
 * the specification-fixed Agent Card path and serves the JSON-RPC endpoint at
 * its mount. Experimental — see `descriptor.ts` for what it does not do.
 */

export type { A2aAdapterOptions } from './adapter.js';
export { A2aProtocolAdapter, createA2aAdapter } from './adapter.js';
export {
  A2A_AGENT_CARD_PATH,
  A2A_DEFAULT_MOUNT_PATH,
  A2A_METHOD_SEND_MESSAGE,
  A2A_PROTOCOL_BINDING,
  A2A_PROTOCOL_VERSION,
  A2A_SPEC_VERSION,
  A2A_VERSION_HEADER,
} from './constants.js';
export { A2A_CAPABILITIES, A2A_UNSUPPORTED } from './descriptor.js';
export type { A2aInvocation } from './message-mapping.js';
export { A2A_USER_ROLE, parseInvocation } from './message-mapping.js';
export type { A2aAgentCard, A2aAgentSkill } from './types.js';
