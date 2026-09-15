/**
 * Adapter self-description.
 *
 * Imports nothing but core types and the pins, so `doctor` can report AP2
 * without pulling `jose` or `@sd-jwt/core` into the CLI bundle.
 */
import type { AdapterDescriptor } from '../../core/index.js';
import {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_CHECKOUT_PROFILE,
  AP2_DIGEST_ALGORITHM,
  AP2_SIGNING_ALGORITHM,
  AP2_SPEC_VERSION,
} from './constants.js';

/** What this provider actually verifies */
export const AP2_CAPABILITIES: readonly string[] = [
  'direct-mode',
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
 * Everything an AP2 client may reasonably expect and will not get here.
 * Complete on purpose: a short list reads as "mostly compatible", which is the
 * blanket claim alpha honesty forbids.
 */
export const AP2_UNSUPPORTED: readonly string[] = [
  // Mandate kinds. Open mandates carry spending constraints nothing here
  // evaluates, so accepting one would tell a buyer their limits were checked.
  'autonomous mode',
  'open checkout mandates (mandate.checkout.open.1)',
  'intent mandates',
  'cart mandates',
  'spending constraint evaluation',
  'cnf-bound agent keys',
  // Key handling. Every key is written into config by an operator
  'JWKS and any key discovery by URL (jku, x5u)',
  'issuer metadata fetching',
  'key rotation without a config change',
  // Algorithms
  'signature algorithms other than ES256',
  'digest algorithms other than sha-256',
  // Roles this gateway does not play
  'mandate issuance',
  'merchant checkout JWT issuance',
  'AP2 over the ACP checkout adapter',
];

export function buildAp2Descriptor(implementationVersion: string): AdapterDescriptor {
  return {
    name: 'ap2',
    kind: 'authorization',
    implementationVersion,
    supportedSpec: `ap2/v${AP2_SPEC_VERSION} mode=direct`,
    capabilities: AP2_CAPABILITIES,
    status: 'experimental',
    unsupported: AP2_UNSUPPORTED,
  };
}
