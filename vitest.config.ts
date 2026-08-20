import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/conformance/**/*.test.ts',
      // The demos keep their tests next to their code. The single-package
      // refactor moved `apps/*/test/**` to `demo/*/test/**` and this line was
      // missed for one commit, silently dropping ten files from the run.
      'demo/*/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
    },
  },
});
