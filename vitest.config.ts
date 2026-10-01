import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/conformance/**/*.test.ts',
      // The demos keep their tests next to their code
      'demo/*/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/*.d.ts',
        // Runs only as a child process (tests/unit/gateway/main.test.ts), which
        // this process's V8 coverage cannot see
        'src/gateway/main.ts',
      ],
      // Enforced by CI's `npm run test:coverage`; `npm test` collects no coverage
      thresholds: {
        lines: 80,
        'src/core/**': { branches: 90 },
        'src/payments/**': { branches: 90 },
      },
    },
  },
});
