/**
 * Adapter self-description.
 *
 * `supportedSpec` is the pinned ACP snapshot, never this package's version.
 * Status is `experimental` while the adapter lacks the features in the
 * unsupported list below; an entry leaves that list only when its feature is
 * implemented.
 */
import type { AdapterDescriptor } from '../../core';
import { ACP_CHECKOUT_OPERATIONS, ACP_SPEC_VERSION } from './constants';

// What this adapter implements
const ACP_CAPABILITIES: readonly string[] = [
  'rest transport',
  'well-known discovery',
  'bearer authentication',
  'API-Version enforcement',
  // Forwarded as received: the gateway verifies neither signature header
  'request header forwarding to the merchant',
  'checkout service',
  ...ACP_CHECKOUT_OPERATIONS,
];

/**
 * Major ACP features this adapter does not implement, served on
 * `/.well-known/agent-commerce` and printed by `doctor`, so no client assumes
 * full protocol support
 */
export const ACP_UNSUPPORTED: readonly string[] = [
  // Services this seller does not implement, named as ACP names them. The
  // discovery document advertises `checkout` alone, and these are the reason.
  'carts service',
  'feed service',
  'standalone orders service',
  'delegate_payment',
  'delegate_authentication',
  // Bindings and delivery directions
  'ACP MCP transport binding',
  'webhooks',
  'outbound merchant-to-agent delivery',
  'ACP client role',
  // Request authentication beyond the bearer token
  'Signature header verification',
  'Timestamp replay-window verification',
  // Extensions, versioning and payment handlers
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
