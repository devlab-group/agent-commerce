/**
 * Public surface of src/payments/x402.
 *
 * Exact factory signatures frozen in docs/contracts.md. Everything else in
 * this package (chain wiring, amount conversion, the local-chain deploy
 * engine used by scripts/chain) is an implementation detail and is
 * deliberately not exported here.
 */

export { type CreatePaymentProofOptions, createPaymentProof } from './client.js';
export { createX402PaymentProvider, type X402ProviderOptions } from './provider.js';
