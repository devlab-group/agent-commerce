/**
 * Adapter self-description.
 *
 * `supportedSpec` reports the MCP protocol revision this adapter targets, as
 * negotiated by the installed @modelcontextprotocol/sdk@1.30.0 build.
 *
 * Verified against the shipped SDK (not guessed):
 * `dist/esm/types.js` exports `LATEST_PROTOCOL_VERSION = '2025-11-25'` and
 * `SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18',
 * '2025-03-26', '2024-11-05', '2024-10-07']`. `dist/esm/server/index.js`
 * (`_oninitialize`) negotiates by echoing the client-requested version when
 * it is in `SUPPORTED_PROTOCOL_VERSIONS`, and falling back to
 * `LATEST_PROTOCOL_VERSION` otherwise — so `LATEST_PROTOCOL_VERSION` is the
 * single most accurate value to report as "the" supported spec revision.
 */
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { AdapterDescriptor } from '../../core/index.js';

/** This package's own version — independent of the negotiated MCP spec revision. */
export { PACKAGE_VERSION } from '../../version.js';

/** The MCP protocol revision this adapter targets (see module doc above). */
export const MCP_SUPPORTED_SPEC = LATEST_PROTOCOL_VERSION;

/** Tool-oriented capabilities this adapter actually implements. */
export const MCP_CAPABILITIES: readonly string[] = ['tools/list', 'tools/call'];

/**
 * MCP surfaces this adapter does not implement in this release. Kept explicit
 * so `doctor` / the support matrix never imply blanket protocol compatibility.
 *
 * `dns-rebinding-protection` is not a missing *feature* so much as a
 * delegated one: this transport does not validate `Origin`/`Host` itself
 * (see adapter.ts's module doc for why) — the gateway's `onRequest` hook
 * does, for `/mcp` and the HTTP routes together. Listed here so alpha
 * honesty holds even for a security property, not just a protocol surface:
 * an operator reading this adapter's own descriptor should not conclude it
 * provides Origin validation on its own.
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
