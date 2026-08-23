import { defineConfig } from 'vitest/config';

/**
 * Base mainnet smoke suite. **This spends real money.**
 *
 * Separate from every other vitest config on purpose. `vitest.config.ts` and
 * `vitest.e2e.config.ts` must never leave the machine; `vitest.testnet.config.ts`
 * spends test funds. This one moves real value, so it is never part of
 * `npm run verify`, never runs on a push or a pull request, and skips itself
 * unless a human has set `ALLOW_X402_MAINNET=true` and supplied credentials.
 *
 * Run it with `npm run test:mainnet`, or from the manual
 * `.github/workflows/mainnet-smoke.yml`.
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
    // No retries, ever: a retried settlement is a second payment.
    retry: 0,
  },
});
