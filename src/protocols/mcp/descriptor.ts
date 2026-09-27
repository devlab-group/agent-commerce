/**
 * Adapter self-description.
 *
 * `supportedSpec` is the SDK's `LATEST_PROTOCOL_VERSION`. The SDK's
 * `initialize` echoes a requested version it supports, older ones included,
 * and otherwise answers with this one, so it is the best single value to
 * report.
 */
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { AdapterDescriptor } from '../../core';

// The MCP protocol revision this adapter targets
const MCP_SUPPORTED_SPEC = LATEST_PROTOCOL_VERSION;

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
