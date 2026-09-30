/**
 * Public surface of src/payments/x402, as documented in docs/contracts.md.
 * Chain wiring, amount conversion and the local-chain tooling stay internal.
 */

export { type CreatePaymentProofOptions, createPaymentProof } from './client';
export type { FacilitatorAuth, X402FacilitatorConfig } from './guardrails';
export {
  type DeploymentMode,
  type NetworkProfile,
  SUPPORTED_NETWORK_IDS,
} from './networks';
export { createX402PaymentProvider, type X402ProviderOptions } from './provider';
