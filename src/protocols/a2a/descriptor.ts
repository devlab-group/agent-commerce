/**
 * Adapter self-description.
 *
 * `supportedSpec` is the A2A specification revision (`1.0.0`), never the
 * negotiation version (`1.0`) and never this package's version. Status is
 * `experimental` while the adapter lacks the features in the unsupported list
 * below; an entry leaves that list only when its feature is implemented.
 */
import type { AdapterDescriptor } from '../../core';
import { A2A_SPEC_VERSION, A2A_UNSUPPORTED_METHODS } from './constants';

// What this adapter implements
const A2A_CAPABILITIES: readonly string[] = ['agent-card', 'jsonrpc', 'SendMessage'];

/**
 * Major A2A features this adapter does not implement, served on
 * `/.well-known/agent-commerce` and printed by `doctor`, so no client assumes
 * full protocol support
 */
export const A2A_UNSUPPORTED: readonly string[] = [
  // Methods, as the protocol names them; the transport refuses the same list
  ...A2A_UNSUPPORTED_METHODS,
  // Transports other than the one binding served
  'HTTP+JSON/REST binding',
  'gRPC binding',
  // Behaviors
  'SSE',
  'long-running task persistence',
  'task resumption',
  'push notifications',
  'multi-turn conversational continuation',
  'authenticated extended agent cards',
  'A2A authentication schemes',
  'artifact types beyond Agent Commerce outcome data',
];

export function buildDescriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'a2a',
    kind: 'protocol',
    implementationVersion,
    supportedSpec: A2A_SPEC_VERSION,
    capabilities: A2A_CAPABILITIES,
    status: 'experimental',
    unsupported: A2A_UNSUPPORTED,
  };
}
