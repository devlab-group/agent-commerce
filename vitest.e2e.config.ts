import { defineConfig } from 'vitest/config';

/**
 * Deterministic end-to-end suite: boots a local Anvil chain, the demo merchant
 * API and the gateway. It must never touch a public RPC, public chain state, a
 * hosted LLM or a hosted x402 facilitator.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
