/**
 * x402 settlement on mainnets. **This spends real money.**
 *
 * Only `npm run test:mainnet` runs it, never CI. Nothing runs unless
 * `X402_SMOKE_TARGETS` names allowlisted targets (`base`, `base-permit2`, `solana`) and
 * `ALLOW_X402_MAINNET=true` is set; each target also needs a funded buyer, a
 * merchant address and an explicit facilitator. The run stops before signing
 * anything when it would exceed its spend cap. The harness lives in
 * tests/fixtures/x402/smoke.
 */
import { defineSmokeSuite } from '../fixtures/x402/smoke/suite';

defineSmokeSuite('mainnet');
