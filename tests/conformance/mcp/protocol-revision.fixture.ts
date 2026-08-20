/**
 * Records the exact MCP protocol revision negotiated by the pinned
 * @modelcontextprotocol/sdk@1.30.0 build, so the project's support matrix
 * () cannot silently drift from what the
 * installed SDK actually does.
 *
 * Verified directly from the shipped build:
 * dist/esm/types.js:
 * LATEST_PROTOCOL_VERSION = '2025-11-25'
 * SUPPORTED_PROTOCOL_VERSIONS = [
 * '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07',
 * ]
 * dist/esm/server/index.js (`_oninitialize`):
 * protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
 * ? requestedVersion
 *: LATEST_PROTOCOL_VERSION;
 *
 * The bundled client (`dist/esm/client/index.js`) always requests
 * `LATEST_PROTOCOL_VERSION` on `initialize`, so a real client/server pair
 * built from this SDK version always settles on this exact revision — the
 * conformance suite asserts that live, not just this fixture value.
 */
export const EXPECTED_MCP_PROTOCOL_REVISION = '2025-11-25';
