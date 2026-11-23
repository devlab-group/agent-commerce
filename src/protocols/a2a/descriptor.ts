/**
 * `supportedSpec` pins the A2A specification revision (`1.0.1`). Negotiation
 * uses `1.0`; the package version is independent. Status and unsupported
 * features come from `src/support/a2a.json`. Remove an unsupported entry only
 * after implementing its feature.
 */
import type { AdapterDescriptor } from '../../core';
import record from '../../support/a2a.json' with { type: 'json' };
import { descriptorStatus, exclusionNames } from '../../support/claims';
import { A2A_SPEC_VERSION } from './constants';

// What this adapter implements
const A2A_CAPABILITIES: readonly string[] = [
  'agent-card',
  'jsonrpc',
  'SendMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'returnImmediately',
  // The x402 A2A transport, opt-in per request
  'x402-extension',
];

/**
 * Unsupported A2A features, published at `/.well-known/agent-commerce` and
 * printed by `doctor` to show the limits of protocol support.
 * The support record also lists the `A2A_UNSUPPORTED_METHODS` refused by the
 * transport.
 */
export const A2A_UNSUPPORTED: readonly string[] = exclusionNames(record);

export function buildDescriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'a2a',
    kind: 'protocol',
    implementationVersion,
    supportedSpec: A2A_SPEC_VERSION,
    capabilities: A2A_CAPABILITIES,
    status: descriptorStatus(record),
    unsupported: A2A_UNSUPPORTED,
  };
}
