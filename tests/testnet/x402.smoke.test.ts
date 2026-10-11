/**
 * x402 settlement on public testnets: Base Sepolia (EIP-3009 and Permit2),
 * Arbitrum Sepolia, Solana devnet and NEAR testnet. It spends testnet funds
 * through public RPCs and facilitators, so only `npm run test:testnet` runs
 * it, never CI (see vitest.testnet.config.ts).
 *
 * `X402_SMOKE_TARGETS` names the targets to run, and then each must run: a
 * missing setting fails. Without it, every target whose settings are present
 * runs, except `base-sepolia-permit2` and `arbitrum-sepolia`, which reuse the
 * Base Sepolia buyer and run only when named; the rest skip, naming what they
 * need. The harness lives in tests/fixtures/x402/smoke.
 */
import { defineSmokeSuite } from '../fixtures/x402/smoke/suite';

defineSmokeSuite('testnet');
