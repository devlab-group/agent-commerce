/**
 * `supportedSpec` lists the modern revision and the newest 2025-era revision.
 * The SDK's legacy fallback also accepts older revisions, back to 2024-10-07.
 * Tests do not negotiate that oldest revision.
 */
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { AdapterDescriptor } from '../../core';
import { descriptorStatus, exclusionNames } from '../../support/claims';
import record from '../../support/mcp.json' with { type: 'json' };
import { MCP_MODERN_PROTOCOL_REVISION } from './constants';

// List the modern revision followed by the SDK's latest legacy revision
const MCP_SUPPORTED_SPEC = `${MCP_MODERN_PROTOCOL_REVISION}, ${LATEST_PROTOCOL_VERSION}`;

// Tool-oriented capabilities this adapter implements
const MCP_CAPABILITIES: readonly string[] = ['tools/list', 'tools/call'];

/**
 * Unsupported MCP surfaces from the support record, published in the descriptor
 * to show the limits of protocol support
 */
export const MCP_UNSUPPORTED: readonly string[] = exclusionNames(record);

export function buildDescriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'mcp',
    kind: 'protocol',
    implementationVersion,
    supportedSpec: MCP_SUPPORTED_SPEC,
    capabilities: MCP_CAPABILITIES,
    status: descriptorStatus(record),
    unsupported: MCP_UNSUPPORTED,
  };
}
