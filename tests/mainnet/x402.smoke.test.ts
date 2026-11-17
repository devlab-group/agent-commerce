/**
 * x402 settlement on mainnets. **This spends real money.**
 *
 * Only `npm run test:mainnet` runs it, never CI. Nothing runs unless
 * `X402_SMOKE_TARGETS` names allowlisted targets (`base`, `base-permit2`,
 * `solana`, `near`) and `ALLOW_X402_MAINNET=true` is set. Each target needs a
 * funded buyer, a merchant address and an explicit facilitator; NEAR can use a
 * relayer instead. The run stops before signing anything that would exceed
 * its spend cap. The harness lives in tests/fixtures/x402/smoke.
 */
import { defineSmokeSuite } from '../fixtures/x402/smoke/suite';

defineSmokeSuite('mainnet');
