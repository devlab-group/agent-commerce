/**
 * `supportedSpec` pins the ACP snapshot independently of the package version.
 * Status and unsupported features come from `src/support/acp.json`.
 * Remove an unsupported entry only after implementing its feature.
 */
import type { AdapterDescriptor } from '../../core';
import record from '../../support/acp.json' with { type: 'json' };
import { descriptorStatus, exclusionNames } from '../../support/claims';
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
 * Unsupported ACP features from the support record, published at
 * `/.well-known/agent-commerce` and printed by `doctor` to show the limits of
 * protocol support
 */
export const ACP_UNSUPPORTED: readonly string[] = exclusionNames(record);

export function buildDescriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'acp',
    kind: 'protocol',
    implementationVersion,
    supportedSpec: ACP_SPEC_VERSION,
    capabilities: ACP_CAPABILITIES,
    status: descriptorStatus(record),
    unsupported: ACP_UNSUPPORTED,
  };
}
