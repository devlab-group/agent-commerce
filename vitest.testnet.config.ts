import { defineConfig } from 'vitest/config';

/**
 * Base Sepolia smoke suite. It uses a public RPC, a public chain and a hosted
 * facilitator, which `vitest.config.ts` and `vitest.e2e.config.ts` must never
 * touch, and spends testnet funds. It is never part of `npm run verify` and
 * skips itself without credentials. Run `npm run test:testnet` from the machine
 * that holds the wallet.
 *
 * There is no CI workflow for it: a workflow means a funded key in repository
 * secrets that anyone with write access could spend. Timeouts are generous
 * because block times and facilitator queues are outside our control.
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
