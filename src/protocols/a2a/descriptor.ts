/**
 * Adapter self-description.
 *
 * `supportedSpec` is the A2A specification revision (`1.0.0`), never the
 * negotiation version (`1.0`) and never this package's version. Status is
 * `experimental` and stays that way until the unsupported list below shrinks
 * on purpose rather than by omission.
 */
import type { AdapterDescriptor } from '../../core/index.js';
import { A2A_SPEC_VERSION } from './constants.js';

/** What this adapter actually implements. */
export const A2A_CAPABILITIES: readonly string[] = ['agent-card', 'jsonrpc', 'SendMessage'];

/**
 * Everything an A2A client may reasonably expect and will not get here.
 * Complete on purpose: a short list reads as "mostly compatible", which is
 * exactly the blanket claim alpha honesty forbids. `doctor` and
 * `/.well-known/agent-commerce` surface this verbatim.
 */
export const A2A_UNSUPPORTED: readonly string[] = [
  // Methods, named as the protocol names them.
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
  // Transports other than the one binding served.
  'HTTP+JSON/REST binding',
  'gRPC binding',
  // Behaviours.
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
