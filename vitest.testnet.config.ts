import { defineConfig } from 'vitest/config';

/**
 * Public-network smoke suite. Separate from `vitest.config.ts` and
 * `vitest.e2e.config.ts` on purpose: both of those must never touch a public
 * RPC, a public chain or a hosted facilitator, and this one does all three.
 *
 * It spends real testnet funds, so it is never part of `npm run verify` and
 * skips itself when its credentials are absent. Run it with
 * `npm run test:testnet`, from a machine that holds the wallet.
 *
 * There is no CI workflow for it, deliberately: a workflow means a funded key
 * in repository secrets, triggerable by anyone with write access. The key
 * stays with a human.
 *
 * Timeouts are generous because a public chain's block time and a hosted
 * facilitator's queue are not ours to control.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/testnet/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: 'forks',
    retry: 0,
  },
});
