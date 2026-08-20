/**
 * `@devlab.group/agent-commerce/x402` — the x402 payment provider (`exact` scheme, EVM).
 *
 * A separate entry point, not part of the main one, because `x402` and `viem`
 * together account for ~648 MB and 206 packages of install weight — x402 pulls
 * a browser wallet-connection stack (wagmi, walletconnect, reown) that this
 * gateway never executes. Making every consumer of `createGateway` carry that
 * to run a free resource was the wrong default.
 *
 * npm install @devlab.group/agent-commerce x402 viem
 * import { x402 } from '@devlab.group/agent-commerce/x402';
 *
 * Both peers are pinned exactly: x402's schemas and EIP-712 domains
 * cross this boundary, so a version skew is a correctness problem, not a
 * convenience one.
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
  type X402ProviderOptions,
} from './payments/x402/index.js';
