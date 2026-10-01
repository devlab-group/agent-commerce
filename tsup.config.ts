import { createRequire } from 'node:module';
import { defineConfig, type Options } from 'tsup';

const require = createRequire(import.meta.url);

const pkg = require('./package.json') as { version?: string };

const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  treeshake: true,
  define: {
    __OAC_PACKAGE_VERSION__: JSON.stringify(pkg.version ?? '0.0.0-unknown'),
  },
  external: ['better-sqlite3'],
} satisfies Options;

/**
 * Two builds.
 *
 * Library: `dist/index.js` plus one entry per optional-peer subpath, built
 * together with `splitting: true` so shared code is emitted once. Separate
 * bundles would each carry their own `CommerceError`, and an error from a
 * subpath would fail `instanceof CommerceError` against the main entry's class.
 *
 * CLI: `dist/cli/index.js`, built separately without shared chunks, so no
 * chunk reaching gateway code can pull `fastify` into it. Packaging tests
 * assert the CLI's imports.
 *
 * tsup keeps `dependencies` and `peerDependencies` external by default, so npm
 * resolves them at install time and an optional peer stays optional.
 * `better-sqlite3` is also listed explicitly: a native module with
 * per-platform prebuilds cannot be inlined.
 */
export default defineConfig([
  {
    ...shared,
    entry: {
      index: 'src/index.ts',
      ap2: 'src/ap2.ts',
      mcp: 'src/mcp.ts',
      mpp: 'src/mpp.ts',
      x402: 'src/x402.ts',
    },
    clean: true,
    splitting: true,
  },
  {
    ...shared,
    entry: { 'cli/index': 'src/cli/index.ts' },
    // Runs second; cleaning here would delete the library build above
    clean: false,
    splitting: false,
    // src/cli/index.ts carries its own shebang, which esbuild preserves. A
    // `banner` here would emit a second one and the output would not parse.
  },
]);
