import { defineConfig } from 'vitest/config';

/**
 * Base mainnet smoke suite. This spends real money.
 *
 * It is never part of `npm run verify`. Each suite skips itself unless its
 * credentials are set and a human has opted in: `ALLOW_X402_MAINNET=true` for
 * x402, `ALLOW_MPP_MAINNET=true` for MPP. Run `npm run test:mainnet` from the
 * machine that holds the wallet.
 *
 * There is no CI workflow for it and there must not be one: a workflow means a
 * mainnet key in repository secrets that anyone with write access could spend.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/mainnet/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    pool: 'forks',
    // No retries: a retried settlement is a second payment
    retry: 0,
  },
});
