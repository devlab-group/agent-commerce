/**
 * `@devlab.group/agent-commerce/x402`: the x402 payment provider (`exact`
 * scheme, EVM). A separate entry point because the rail brings the EVM signing
 * and RPC stack, which a consumer serving free resources should not install.
 *
 *   npm install @devlab.group/agent-commerce @x402/core @x402/evm viem
 *   import { x402 } from '@devlab.group/agent-commerce/x402';
 *
 * A remote facilitator with `auth.type: cdp` also needs `@coinbase/x402`.
 *
 * The peers are pinned exactly: x402's zod schemas and EIP-712 domain
 * construction cross this boundary, so version skew is a correctness problem.
 *
 * Not exported: `./payments/x402/testing`, the local-chain tooling (Anvil,
 * the deploy engine and the development keys) that serves demos and tests.
 */

export {
  type CreatePaymentProofOptions,
  createPaymentProof,
  createX402PaymentProvider,
  // `x402` reads well at a call site; the full name reads better in a stack trace
  createX402PaymentProvider as x402,
  type DeploymentMode,
  type FacilitatorAuth,
  type NetworkProfile,
  SUPPORTED_NETWORK_IDS,
  type X402FacilitatorConfig,
  type X402ProviderOptions,
} from './payments/x402';
