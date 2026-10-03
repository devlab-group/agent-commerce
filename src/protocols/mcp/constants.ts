/**
 * MCP protocol constants shared by the config layer, the adapter and the
 * OpenAPI importer.
 *
 * Kept dependency-free: `src/config` validates tool names at load time, so
 * anything imported here would become a config-load dependency too, and the
 * MCP SDK is an optional peer the main entry and CLI must never load.
 */

/** Characters SEP-986 allows in an MCP tool name, as a regex character class body */
export const MCP_TOOL_NAME_CHARS = 'A-Za-z0-9._-';

/** Longest MCP tool name SEP-986 allows */
export const MCP_TOOL_NAME_MAX_LENGTH = 128;

/**
 * MCP tool names per SEP-986: 1-128 chars of [A-Za-z0-9._-], the SDK's own
 * `TOOL_NAME_REGEX`, which it does not export. Config refuses an mcp-exposed
 * resource whose id fails it; the low-level `Server` checks no names, so the
 * adapter also skips such an id with a warning.
 */
export const MCP_TOOL_NAME_PATTERN = new RegExp(
  `^[${MCP_TOOL_NAME_CHARS}]{1,${MCP_TOOL_NAME_MAX_LENGTH}}$`,
);

/**
 * The modern revision served by the SDK. A v2 client negotiates this value
 * in the conformance test.
 */
export const MCP_MODERN_PROTOCOL_REVISION = '2026-07-28';
