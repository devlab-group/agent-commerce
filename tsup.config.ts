import { createRequire } from 'node:module';
import { defineConfig, type Options } from 'tsup';

const require = createRequire(import.meta.url);

const pkg = require('./package.json') as {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/**
 * Two builds.
 *
 * **Library** - `dist/index.js` plus one entry per optional-peer subpath. These
 * are built together with `splitting: true`, which emits shared code once.
 * Separate bundles would each contain `CommerceError`, making an error from a
 * subpath fail `instanceof CommerceError` against the main entry's class.
 *
 * **CLI** - `dist/cli/index.js`, built separately and deliberately *not*
 * sharing library chunks. A shared chunk that reaches gateway code would pull
 * `fastify` into the CLI and undo the dependency split. Packaging tests assert
 * the CLI's imports.
 *
 * Everything under `src/` is internal to this package, so there is nothing to
 * "bundle in" from elsewhere. What matters is what stays *external*: every
 * runtime and peer dependency is resolved by npm at install time rather than
 * inlined, which is the only way `better-sqlite3` can work at all (native,
 * per-platform prebuilds) and the only way an optional peer can be optional.
 */
function versionReport(): string {
  // Peers included: the pinned protocol/SDK versions the report exists to show
  // are exactly the ones that moved out of `dependencies` to keep the default
  // install small. Reading only `dependencies` would blank the report.
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
  const wanted = [
    '@coinbase/x402',
    '@modelcontextprotocol/sdk',
    '@x402/core',
    '@x402/evm',
    'viem',
    'better-sqlite3',
    'fastify',
    'pino',
    'zod',
  ];
  const pinned = wanted
    .map((name) => ({ name, version: deps[name], via: '@devlab.group/agent-commerce' }))
    .filter((p): p is { name: string; version: string; via: string } => p.version !== undefined);
  return JSON.stringify({ cliVersion: pkg.version ?? '0.0.0-unknown', pinned });
}

const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  treeshake: true,
  define: {
    __OAC_VERSION_REPORT__: JSON.stringify(versionReport()),
    __OAC_PACKAGE_VERSION__: JSON.stringify(pkg.version ?? '0.0.0-unknown'),
  },
  external: ['better-sqlite3'],
} satisfies Options;

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
    // Runs second; cleaning here would delete the library build above.
    clean: false,
    splitting: false,
    // src/cli/index.ts carries its own shebang and esbuild preserves an entry
    // point's. A `banner` here would emit a second one and the output would
    // not parse.
  },
]);
