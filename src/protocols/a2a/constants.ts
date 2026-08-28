/**
 * A2A pins, kept in one place so nothing infers one version from another.
 *
 * The specification revision and the protocol negotiation version are
 * different values that look similar: `1.0.0` names the document this adapter
 * was written against, `1.0` is what a client negotiates on the wire. Neither
 * is this package's version — that is `PACKAGE_VERSION`.
 */

/** A2A specification revision this adapter targets. */
export const A2A_SPEC_VERSION = '1.0.0';

/** Protocol negotiation version carried on the wire. */
export const A2A_PROTOCOL_VERSION = '1.0';

/** The only transport binding this adapter serves. */
export const A2A_PROTOCOL_BINDING = 'JSONRPC';

/**
 * Fixed by the A2A specification: a client fetches the card from this exact
 * path, so it is not configurable. `src/config` reserves it against adapter
 * mounts for the same reason.
 */
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** Mount serving the JSON-RPC endpoint, unless configuration says otherwise. */
export const A2A_DEFAULT_MOUNT_PATH = '/a2a';

/** Content type on both sides of every supported A2A exchange. */
export const A2A_JSON_MEDIA_TYPE = 'application/json';

/** Card identity when the operator names none. Matches the MCP server name. */
export const A2A_DEFAULT_AGENT_NAME = 'agent-commerce';
