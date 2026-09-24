/**
 * Describes the planned MPP profile and its unsupported variants.
 *
 * The protocol name alone cannot identify a compatible intent, method and
 * extension set, so the descriptor lists both the target and its gaps.
 *
 * Importing the descriptor does not load `mppx`.
 */
import type { AdapterDescriptor } from '../../core/public-types.js';
import { PACKAGE_VERSION } from '../../version.js';
import { MPP_PROFILE, MPP_SUPPORTED_SPEC } from './constants.js';

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
    `network=${MPP_PROFILE.network}`,
    `asset=${MPP_PROFILE.assetSymbol}`,
    'verify-before-settle',
    'payment-receipt',
  ],
  // Config cannot enable the rail, so the descriptor remains planned
  status: 'planned',
  unsupported: [
    // Name other methods as a class instead of maintaining a second list
    'methods other than evm',
    // This profile supports only the EIP-3009 `authorization` credential
    'credential=permit2',
    'credential=transaction',
    'credential=hash',
    // The draft allows splits only with permit2 credentials
    'splits',
    'intent=subscription',
    // A separate EVM draft, not an option of charge
    'evm sessions',
    'discovery extension',
  ],
};
