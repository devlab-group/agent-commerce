/**
 * Thin wrapper around the MCP SDK client, connected over Streamable HTTP to
 * the gateway's `/mcp` mount. One session per demo run.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { PACKAGE_VERSION } from '../../../src/version.js';

const CLIENT_NAME = 'agent-commerce-demo-agent';
const CLIENT_VERSION = PACKAGE_VERSION;

export interface McpSession {
  listTools(): Promise<readonly Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Connects an MCP client to `<gatewayUrl>/mcp` over Streamable HTTP. */
export async function connectMcpSession(gatewayUrl: string): Promise<McpSession> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${gatewayUrl.replace(/\/$/, '')}/mcp`),
  );
  // StreamableHTTPClientTransport implements Transport per the SDK's own
  // declaration; the cast works around its onclose/onerror accessors being
  // typed `T | undefined` where Transport declares a bare optional T, which
  // only conflicts under this project's exactOptionalPropertyTypes (mirrors
  // the equivalent cast on the server side in protocol-mcp/src/adapter.ts).
  await client.connect(transport as Transport);

  return {
    async listTools(): Promise<readonly Tool[]> {
      const result = await client.listTools();
      return result.tools;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}
