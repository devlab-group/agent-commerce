/**
 * Adapter self-description.
 *
 * `supportedSpec` is the pinned ACP snapshot, never this package's version.
 * Status is `experimental` and stays that way until the unsupported list below
 * shrinks on purpose rather than by omission.
 */
import type { AdapterDescriptor } from '../../core/index.js';
import { ACP_CHECKOUT_OPERATIONS, ACP_SPEC_VERSION } from './constants.js';

/** What this adapter actually implements. */
export const ACP_CAPABILITIES: readonly string[] = [
  'rest transport',
  'well-known discovery',
  'bearer authentication',
  'API-Version negotiation',
  'checkout service',
  ...ACP_CHECKOUT_OPERATIONS,
];

/**
 * Everything an ACP client may reasonably expect and will not get here.
 * Complete on purpose: a short list reads as "mostly compatible", which is
 * exactly the blanket claim alpha honesty forbids. `doctor` and
 * `/.well-known/agent-commerce` surface this verbatim.
 */
export const ACP_UNSUPPORTED: readonly string[] = [
  // Services this seller does not implement, named as ACP names them. The
  // discovery document advertises `checkout` alone, and these are the reason.
  'carts service',
  'feed service',
  'standalone orders service',
  'delegate_payment',
  'delegate_authentication',
  // Bindings and delivery directions.
  'ACP MCP transport binding',
  'webhooks',
  'outbound merchant-to-agent delivery',
  'ACP client role',
  // Request authentication beyond the bearer token.
  'Signature header verification',
  'Timestamp replay-window verification',
  // Extensions and versioning.
  'discount extension',
  'general ACP extension framework',
  'multiple ACP API versions',
  'seller-backed payment handler integration',
];

export function buildDescriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'acp',
    kind: 'protocol',
    implementationVersion,
    supportedSpec: ACP_SPEC_VERSION,
    capabilities: ACP_CAPABILITIES,
    status: 'experimental',
    unsupported: ACP_UNSUPPORTED,
  };
}
