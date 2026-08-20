/**
 * `@devlab.group/agent-commerce/mcp` — the MCP protocol adapter.
 *
 * A separate entry point, not part of the main one, because it is the only
 * thing that needs `@modelcontextprotocol/sdk` — an optional peer dependency
 * worth ~17 MB and 82 packages. A consumer running free HTTP resources, or
 * speaking only their own protocol, should not install it to import
 * `createGateway`.
 *
 * npm install @devlab.group/agent-commerce @modelcontextprotocol/sdk
 * import { mcp } from '@devlab.group/agent-commerce/mcp';
 *
 * Without the peer installed, importing this subpath fails at load with
 * Node's own ERR_MODULE_NOT_FOUND naming the SDK. That is deliberate: a
 * missing protocol adapter must not degrade into a gateway that silently
 * serves nothing.
 */

export type { McpAdapterOptions } from './protocols/mcp/index.js';
// `mcp` reads well at a call site; the full name reads better in a stack trace.
export { createMcpAdapter as mcp, createMcpAdapter } from './protocols/mcp/index.js';
