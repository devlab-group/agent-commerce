/**
 * `@devlab.group/agent-commerce/x402` — the x402 payment provider (`exact` scheme, EVM).
 *
 * A separate entry point, not part of the main one, because the x402 rail
 * brings the whole EVM signing and RPC stack with it. Making every consumer of
 * `createGateway` carry that to serve a free resource was the wrong default.
 *
 * npm install @devlab.group/agent-commerce @x402/core @x402/evm viem
 * import { x402 } from '@devlab.group/agent-commerce/x402';
 *
 * The peers are pinned exactly: x402's zod schemas and EIP-712 domain
 * construction cross this boundary, so a version skew is a correctness
 * problem, not a convenience one.
 *
 * Deliberately absent: `./payments/x402/testing.js`, which carries the Anvil
 * development keys, and the local-chain deploy engine. Those are demo and test
 * affordances and are not part of the shipped API.
 */

export {
  type CreatePaymentProofOptions,
  createPaymentProof,
  createX402PaymentProvider,
  // `x402` reads well at a call site; the full name reads better in a trace.
  createX402PaymentProvider as x402,
  type DeploymentMode,
  type FacilitatorAuth,
  type NetworkProfile,
  SUPPORTED_NETWORK_IDS,
  type X402FacilitatorConfig,
  type X402ProviderOptions,
} from './payments/x402/index.js';
