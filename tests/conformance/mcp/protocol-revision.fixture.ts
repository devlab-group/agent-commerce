/**
 * The MCP protocol revision the pinned SDK negotiates, its
 * `LATEST_PROTOCOL_VERSION`. The SDK client always requests that revision and
 * the SDK server echoes any version it supports, so a client and server built
 * from this SDK settle on it. The conformance suite also asserts it live.
 */
export const EXPECTED_MCP_PROTOCOL_REVISION = '2025-11-25';
