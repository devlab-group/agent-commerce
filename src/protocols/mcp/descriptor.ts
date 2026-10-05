/**
 * Adapter self-description. `supportedSpec` lists the modern revision and
 * the newest 2025-era revision. The SDK's legacy fallback also accepts older
 * 2025-era revisions.
 */
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { AdapterDescriptor } from '../../core';
import { MCP_MODERN_PROTOCOL_REVISION } from './constants';

// List the modern revision followed by the SDK's latest legacy revision
const MCP_SUPPORTED_SPEC = `${MCP_MODERN_PROTOCOL_REVISION}, ${LATEST_PROTOCOL_VERSION}`;

// Tool-oriented capabilities this adapter implements
const MCP_CAPABILITIES: readonly string[] = ['tools/list', 'tools/call'];

/**
 * MCP surfaces this adapter does not implement, listed so its descriptor never
 * implies blanket protocol compatibility.
 *
 * `dns-rebinding-protection` is delegated rather than missing: the gateway's
 * `onRequest` hook validates Host and Origin for `/mcp` (see adapter.ts), and
 * the adapter provides none on its own.
 */
export const MCP_UNSUPPORTED: readonly string[] = [
  'resources',
  'prompts',
  'sampling',
  'completions',
  'elicitation',
  'roots',
  'logging',
  'notifications/tools/list_changed',
  'tasks',
  'dns-rebinding-protection',
  'authorization',
  'sessions',
  'subscriptions',
  'pagination',
  'HTTP+SSE transport',
  // mppx reads challenges and refusals from tool-result `_meta`.
  'MPP payment-required as JSON-RPC error -32042',
  'MPP verification failure as JSON-RPC error -32043',
];

export function buildDescriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'mcp',
    kind: 'protocol',
    implementationVersion,
    supportedSpec: MCP_SUPPORTED_SPEC,
    capabilities: MCP_CAPABILITIES,
    status: 'stable',
    unsupported: MCP_UNSUPPORTED,
  };
}
