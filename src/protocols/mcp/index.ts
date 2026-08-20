/**
 * src/protocols/mcp
 *
 * MCP (Model Context Protocol) adapter: exposes canonical resources as MCP
 * tools and routes every `tools/call` through the frozen `ExecutionPipeline`.
 * See docs/contracts.md for the exact factory signature this package exports.
 */

export type { McpAdapterOptions } from './adapter.js';
export { createMcpAdapter } from './adapter.js';
