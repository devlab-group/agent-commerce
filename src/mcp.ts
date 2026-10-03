/**
 * `@devlab.group/agent-commerce/mcp`: the MCP protocol adapter. A separate entry
 * point because it needs the optional peer `@modelcontextprotocol/server`, which
 * a consumer importing only `createGateway` should not have to install.
 *
 *   npm install @devlab.group/agent-commerce @modelcontextprotocol/server
 *   import { mcp } from '@devlab.group/agent-commerce/mcp';
 *
 * Without the peer, importing this subpath fails at load with Node's
 * ERR_MODULE_NOT_FOUND naming the SDK, rather than yielding a gateway that
 * silently serves nothing.
 */

export type { McpAdapterOptions } from './protocols/mcp';
// `mcp` reads well at a call site; the full name reads better in a stack trace
export { createMcpAdapter as mcp, createMcpAdapter } from './protocols/mcp';
