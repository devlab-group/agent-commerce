/**
 * Describes the MPP profile and its unsupported variants.
 *
 * The descriptor identifies the intent, method, extensions and unsupported
 * variants needed to assess compatibility. Status and unsupported variants
 * come from `src/support/mpp.json`.
 *
 * Importing the descriptor does not load `mppx`.
 */
import type { AdapterDescriptor } from '../../core/public-types';
import { descriptorStatus, exclusionNames } from '../../support/claims';
import record from '../../support/mpp.json' with { type: 'json' };
import { PACKAGE_VERSION } from '../../version';
import { MPP_NETWORKS, MPP_PROFILE, MPP_SUPPORTED_SPEC } from './constants';

export const MPP_DESCRIPTOR: AdapterDescriptor = {
  name: 'mpp',
  kind: 'payment',
  implementationVersion: PACKAGE_VERSION,
  supportedSpec: MPP_SUPPORTED_SPEC,
  capabilities: [
    `intent=${MPP_PROFILE.intent}`,
    `method=${MPP_PROFILE.method}`,
    `credential=${MPP_PROFILE.credentialType}`,
    'eip-3009',
    ...MPP_NETWORKS.map((network) => `network=${network}`),
    `asset=${MPP_PROFILE.assetSymbol}`,
    'verify-before-settle',
    'authorization-flow',
    'upfront-flow',
    'payment-receipt',
    // HTTP request bodies only; MCP and A2A carry the proof in the body
    'challenge-digest-binding',
  ],
  status: descriptorStatus(record),
  unsupported: exclusionNames(record),
};
