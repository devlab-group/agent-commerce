// AP2 pins and support metadata for diagnostics, without loading the optional
// `jose` or `@sd-jwt/core` peers
import type { AdapterDescriptor } from '../../core';
import record from '../../support/ap2.json' with { type: 'json' };
import { descriptorStatus, exclusionNames } from '../../support/claims';
import {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_CHECKOUT_PROFILE,
  AP2_DIGEST_ALGORITHM,
  AP2_SIGNING_ALGORITHM,
  AP2_SPEC_VERSION,
} from './constants';

/** What this provider actually verifies */
export const AP2_CAPABILITIES: readonly string[] = [
  'direct-mode',
  'trusted-agent-provider',
  AP2_CHECKOUT_MANDATE_VCT,
  'sd-jwt-presentation',
  AP2_SIGNING_ALGORITHM,
  AP2_DIGEST_ALGORITHM,
  'static-inline-trust',
  'merchant-checkout-jwt-binding',
  AP2_CHECKOUT_PROFILE,
  'purchase-binding',
  'replay-defence',
];

/**
 * Unsupported AP2 features from the support record, published in the descriptor
 * and printed by `doctor` to show the limits of protocol support
 */
export const AP2_UNSUPPORTED: readonly string[] = exclusionNames(record);

export function buildAp2Descriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'ap2',
    kind: 'authorization',
    implementationVersion,
    supportedSpec: `ap2/v${AP2_SPEC_VERSION} mode=direct`,
    capabilities: AP2_CAPABILITIES,
    status: descriptorStatus(record),
    unsupported: AP2_UNSUPPORTED,
  };
}
