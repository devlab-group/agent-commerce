/**
 * Packaging surface tests, against the package manifest and the real built
 * `dist/`.
 *
 * The published artifact is built by a different path than everything else,
 * so it can break while every other test stays green. The `dist/` suites skip
 * (reported, not passed) when it is absent, so `npm test` works on a fresh
 * clone; CI runs `npm run build` first and then this file.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const distEntry = join(pkgRoot, 'dist', 'cli', 'index.js');
const libEntry = join(pkgRoot, 'dist', 'index.js');
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
  name: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  exports?: Record<string, unknown>;
  overrides?: Record<string, string>;
  publishConfig?: { access?: string };
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  pnpm?: unknown;
};

// Node builtins as they appear when imported without the `node:` prefix
const BUILTINS = new Set([
  'fs',
  'path',
  'url',
  'crypto',
  'module',
  'child_process',
  'fs/promises',
  'os',
  'util',
  'events',
  'stream',
  'buffer',
  'process',
  'http',
  'https',
  'net',
  'tty',
  'zlib',
]);

/**
 * Every bare (non-relative, non-builtin) package an ESM bundle imports.
 *
 * Matches `import x from 'p'`, `export … from 'p'`, the side-effect form
 * `import 'p'` and the dynamic `import('p')`. esbuild emits the side-effect
 * form for an external whose bindings were tree-shaken but whose side effects
 * it cannot prove absent, and missing it would report the CLI viem-free while
 * the published binary cannot start without viem. A dynamic import fails later,
 * when the code path that calls it runs.
 */
const bareImportsOf = (file: string): string[] => {
  const pattern =
    /^(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
  const packages = new Set<string>();
  const seen = new Set<string>();

  // Follows relative imports, static and dynamic: the library entries are
  // built with `splitting: true`, so shared code lives in `dist/chunk-*.js`,
  // and a peer import that moved into a chunk would otherwise go unseen
  const visit = (path: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const spec = (match[1] ?? match[2] ?? match[3]) as string;
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        visit(resolve(dirname(path), spec));
        continue;
      }
      const pkg = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : (spec.split('/')[0] as string);
      if (!BUILTINS.has(pkg)) packages.add(pkg);
    }
  };

  visit(file);
  return [...packages].sort();
};

const built = existsSync(distEntry);
const run = (...args: string[]): string =>
  execFileSync(process.execPath, [distEntry, ...args], { encoding: 'utf8' });

describe('the bundle import scanner', () => {
  it('finds side-effect and dynamic imports, including those in relative chunks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-commerce-scan-'));
    writeFileSync(join(dir, 'entry.js'), "import { a } from './chunk.js';\nimport 'node:fs';\n");
    writeFileSync(
      join(dir, 'chunk.js'),
      "import 'viem';\nimport 'fs';\nexport { b } from '@x402/core/schemas';\nexport const lazy = () => import('./lazy.js');\n",
    );
    writeFileSync(join(dir, 'lazy.js'), 'export const load = () => import("mppx");\n');

    expect(bareImportsOf(join(dir, 'entry.js'))).toEqual(['@x402/core', 'mppx', 'viem']);
  });
});

describe('published package metadata', () => {
  it('is publishable - not marked private', () => {
    expect(manifest.private).toBeUndefined();
  });

  it('exposes the agent-commerce executable, pointing at compiled JS', () => {
    const bin = manifest.bin?.['agent-commerce'];
    expect(bin).toBe('dist/cli/index.js');
    // No leading `./`: npm >= 12 treats that as an invalid bin target and
    // removes the entry, publishing a package with no binary (with only an
    // `npm warn` to say so)
    expect(bin?.startsWith('./')).toBe(false);
  });

  it('is not a workspace: no pnpm-workspace.yaml, and the root is publishable', () => {
    // Boundaries live in src/ directories, not in package manifests
    expect(existsSync(resolve(pkgRoot, 'pnpm-workspace.yaml'))).toBe(false);
    expect(existsSync(resolve(pkgRoot, 'packages'))).toBe(false);
  });

  it('is an npm project: one npm lockfile, no pnpm lockfile', () => {
    // Two lockfiles mean the tested tree may not be the resolved one. Docker
    // and CI install with `npm ci`, which fails without package-lock.json.
    expect(existsSync(resolve(pkgRoot, 'package-lock.json'))).toBe(true);
    expect(existsSync(resolve(pkgRoot, 'pnpm-lock.yaml'))).toBe(false);
  });

  it('pins zod for the x402 packages, per package rather than repo-wide', () => {
    // Two zod majors in one graph break `instanceof` across module
    // boundaries, so every package that shares zod values with ours resolves
    // to *our* zod. Not repo-wide: `@scalar/openapi-parser` and `mppx` need
    // zod 4 and get their own nested copies, and only plain values cross those
    // seams.
    const overrides = manifest.overrides as Record<string, unknown> | undefined;
    expect(overrides?.['zod']).toBeUndefined();
    for (const pkg of ['@x402/core', '@x402/evm', '@coinbase/x402']) {
      expect((overrides?.[pkg] as Record<string, string> | undefined)?.['zod']).toBe(
        manifest.dependencies?.['zod'],
      );
    }
    expect(manifest.pnpm).toBeUndefined();
  });

  it('keeps the AP2 crypto libraries optional and exactly pinned', () => {
    // A mandate decides whether a purchase was authorized, so nothing in that
    // path floats. `jose` and `@sd-jwt/core` are optional peers because a
    // consumer serving a free HTTP resource should not install a JOSE stack,
    // and they are pinned because a signature verifier is not somewhere to
    // accept whatever a fresh install resolves to.
    for (const peer of ['jose', '@sd-jwt/core']) {
      expect(manifest.peerDependencies?.[peer]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.peerDependenciesMeta?.[peer]?.optional).toBe(true);
      expect(manifest.dependencies?.[peer]).toBeUndefined();
      expect(manifest.devDependencies?.[peer]).toBe(manifest.peerDependencies?.[peer]);
    }
    // `@sd-jwt/core` ships a caret range on a 0.x package, which is the one
    // transitive in the whole graph that sits inside signature verification
    const overrides = manifest.overrides as Record<string, unknown> | undefined;
    expect(
      (overrides?.['@sd-jwt/core'] as Record<string, string> | undefined)?.['@owf/identity-common'],
    ).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('ships a library entry alongside the CLI', () => {
    const exportsField = manifest.exports as Record<string, unknown> | undefined;
    expect(exportsField?.['.']).toBeDefined();
  });

  it('gates the heavy adapters behind subpaths with optional peers', () => {
    // Keep protocol-specific peers off the main entry and CLI. Their public
    // surfaces use subpaths, and the peers remain optional.
    const exportsField = manifest.exports as Record<string, unknown> | undefined;
    for (const subpath of ['./ap2', './mcp', './mpp', './x402']) {
      expect(exportsField?.[subpath]).toBeDefined();
    }
    for (const peer of [
      '@coinbase/x402',
      '@modelcontextprotocol/sdk',
      '@sd-jwt/core',
      '@x402/core',
      '@x402/evm',
      'canonicalize',
      'jose',
      'mppx',
      'viem',
    ]) {
      expect(manifest.peerDependencies?.[peer]).toBeDefined();
      expect(manifest.peerDependenciesMeta?.[peer]?.optional).toBe(true);
      // Also listing it in `dependencies` would make npm install it for every consumer
      expect(manifest.dependencies?.[peer]).toBeUndefined();
      // The repo itself still builds and tests against it
      expect(manifest.devDependencies?.[peer]).toBe(manifest.peerDependencies?.[peer]);
    }
  });

  it('declares no workspace:* runtime dependency', () => {
    // npm cannot resolve a `workspace:` range, and src/ is bundled anyway
    const leaked = Object.entries(manifest.dependencies ?? {}).filter(([, v]) =>
      v.includes('workspace:'),
    );
    expect(leaked).toEqual([]);
  });

  it('publishes under the @devlab.group scope, explicitly public', () => {
    // A scoped package defaults to `restricted`. Without publishConfig.access
    // a `npm publish` either fails on a free account or silently publishes a
    // private package - the failure mode that looks like success.
    expect(manifest.name).toBe('@devlab.group/agent-commerce');
    expect(manifest.publishConfig?.access).toBe('public');
  });

  it('keeps the native dependency declared rather than bundled', () => {
    // better-sqlite3 arrives via the bundled receipt-store. Native modules
    // cannot be inlined into a JS bundle; npm must install a per-platform
    // binary.
    expect(manifest.dependencies?.['better-sqlite3']).toBeDefined();
  });

  it('publishes only distributable files', () => {
    expect([...(manifest.files ?? [])].sort()).toEqual(['LICENSE', 'README.md', 'dist']);
  });

  // The minimum the README documents; CI runs every job on it
  it('requires Node 22 or later', () => {
    expect(manifest.engines?.['node']).toBe('>=22');
  });
});

describe.skipIf(!built)('built executable', () => {
  it('starts with exactly one shebang, on the first line', () => {
    const source = readFileSync(distEntry, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(source.split('\n').filter((l) => l.startsWith('#!')).length).toBe(1);
  });

  it('runs --help and --version under plain node, without tsx', () => {
    expect(run('--help')).toContain('agent-commerce');
    expect(run('--version').trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 1 for a missing config and for an unknown command', () => {
    const status = (...args: string[]): number | null =>
      spawnSync(process.execPath, [distEntry, ...args], { encoding: 'utf8' }).status;
    expect(status('validate', '--config', join(pkgRoot, 'does-not-exist.yaml'))).toBe(1);
    expect(status('not-a-command')).toBe(1);
    expect(status('--help')).toBe(0);
  });

  it('reports real pinned versions, not the unresolved fallback', () => {
    // The bundle carries the manifest it was built from. A regression shows up
    // as "0.0.0-unknown" and an empty pinned list.
    const out = run('version');
    expect(out).not.toContain('0.0.0-unknown');
    expect(out).toContain('@modelcontextprotocol/sdk');
    expect(out).toContain('x402');
  });

  it('offers every documented command', () => {
    const help = run('--help');
    for (const command of ['init', 'import', 'validate', 'doctor', 'demo', 'version']) {
      expect(help).toContain(command);
    }
  });

  it('runs the openapi importer from the built binary', () => {
    // The importer brings its own runtime dependency (@scalar/openapi-parser).
    // The source tests import it directly, so only the built binary shows a
    // bundling mistake there.
    const help = run('import', 'openapi', '--help');
    expect(help).toContain('--expose');
    expect(help).toContain('--base-url');
  });

  it('resolves its own version without reading a manifest by relative path', () => {
    // Bundling changes the directory depth, so a relative `package.json`
    // require resolves from the wrong place. The package version is injected at
    // build time and the version report inlines the manifest instead. Any call
    // counts, because esbuild renames a local `require` (to `require2`), and
    // every file is read, because the library's version code sits in a chunk.
    const files = readdirSync(join(pkgRoot, 'dist'), { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.js'),
    );
    expect(files).toContain(join('cli', 'index.js'));
    for (const file of files) {
      expect(readFileSync(join(pkgRoot, 'dist', file), 'utf8'), file).not.toMatch(
        /\(\s*['"]\.\.?\/[^'"]*package\.json['"]\s*\)/,
      );
    }
  });

  it('leaves only npm-resolvable modules as imports', () => {
    // `dependencies` only - not the optional peers. The binary must run on a
    // default `npm i @devlab.group/agent-commerce`, with nothing else installed.
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const imports = bareImportsOf(distEntry);
    expect(imports).toContain('commander');
    for (const pkg of imports) {
      expect(declared).toContain(pkg);
    }
  });
});

describe.skipIf(!existsSync(libEntry))('built library entry', () => {
  // The library entry is built by the same path as the CLI, so it fails the
  // same ways. Loaded in a subprocess, so an import failure is a failed
  // assertion rather than a test runner crash.
  const load = (expr: string): string =>
    execFileSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(libEntry)}).then((m) => { ${expr} })`],
      { encoding: 'utf8' },
    );

  it('loads under plain node and exports the documented API', () => {
    const out = load(
      "process.stdout.write(['createGateway','receipts','loadConfig','parseConfig'].filter((k) => typeof m[k] !== 'function').join(','))",
    );
    expect(out).toBe('');
  });

  it('does not re-export the optional-peer adapters', () => {
    // They live on the `./mcp` and `./x402` subpaths. Re-exporting them here
    // would import the peers from the main entry, and a bare install would
    // fail on `import { createGateway }`.
    const out = load(
      "process.stdout.write(['mcp','x402','createMcpAdapter','createX402PaymentProvider'].filter((k) => m[k] !== undefined).join(','))",
    );
    expect(out).toBe('');
  });

  it('exports the canonical error type', () => {
    expect(load('process.stdout.write(typeof m.CommerceError)')).toBe('function');
  });

  it('reports the real package version, not the unresolved fallback', () => {
    const version = load(
      "const s = m.receipts({ path: ':memory:' }); process.stdout.write(s.descriptor.implementationVersion)",
    );
    const manifestVersion = (
      JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string }
    ).version;
    expect(version).not.toContain('0.0.0-unknown');
    // The likeliest cause of a mismatch is a stale `dist/`: the version is
    // injected at build time. The message says so, because the bare assertion
    // reads like a source bug.
    expect(
      version,
      `built bundle reports "${version}" but package.json says "${manifestVersion}". ` +
        'The version is injected at build time, so `dist/` is almost certainly stale - ' +
        'run `npm run build` and re-run this test.',
    ).toBe(manifestVersion);
  });
});

describe.skipIf(!existsSync(libEntry))('optional-peer subpaths', () => {
  const ap2Entry = join(pkgRoot, 'dist', 'ap2.js');
  const mcpEntry = join(pkgRoot, 'dist', 'mcp.js');
  const mppEntry = join(pkgRoot, 'dist', 'mpp.js');
  const x402Entry = join(pkgRoot, 'dist', 'x402.js');

  it('keeps every optional peer out of the main entry and the CLI', () => {
    // If either always-installed entry imports an optional peer, a bare
    // install is broken
    const peers = Object.keys(
      (
        JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
          peerDependencies?: Record<string, string>;
        }
      ).peerDependencies ?? {},
    );
    expect(peers.length).toBeGreaterThan(0);
    for (const [entry, ownImport] of [
      [libEntry, 'fastify'],
      [distEntry, 'commander'],
    ] as const) {
      const imports = bareImportsOf(entry);
      expect(imports).toContain(ownImport);
      expect(imports.filter((pkg) => peers.includes(pkg))).toEqual([]);
    }
  });

  it('imports only its own peer, in each subpath', () => {
    expect(bareImportsOf(mcpEntry)).toEqual(['@modelcontextprotocol/sdk']);
    // `@coinbase/x402` is a dynamic import, loaded only for facilitator auth.type `cdp`
    expect(bareImportsOf(x402Entry).sort()).toEqual([
      '@coinbase/x402',
      '@x402/core',
      '@x402/evm',
      'viem',
    ]);
    // MPP settles through an x402 facilitator, so its entry also imports the x402 peers
    expect(bareImportsOf(mppEntry).sort()).toEqual([
      '@coinbase/x402',
      '@x402/core',
      '@x402/evm',
      'mppx',
      'viem',
    ]);
    // `better-sqlite3` rides along through the shared storage chunk: the AP2
    // replay store is a SQLite file. It is a real dependency, not a peer, so
    // it is always installed anyway.
    expect(bareImportsOf(ap2Entry).sort()).toEqual([
      '@sd-jwt/core',
      'better-sqlite3',
      'canonicalize',
      'jose',
    ]);
  });

  it('exports its factory under both the short and the full name', () => {
    const probe = (file: string, names: string[]): string =>
      execFileSync(
        process.execPath,
        [
          '-e',
          `import(${JSON.stringify(file)}).then((m) => process.stdout.write(${JSON.stringify(names)}.filter((k) => typeof m[k] !== 'function').join(',')))`,
        ],
        { encoding: 'utf8' },
      );
    expect(probe(mcpEntry, ['mcp', 'createMcpAdapter'])).toBe('');
    expect(probe(x402Entry, ['x402', 'createX402PaymentProvider', 'createPaymentProof'])).toBe('');
    expect(probe(mppEntry, ['mpp', 'createMppPaymentProvider'])).toBe('');
    expect(probe(ap2Entry, ['ap2', 'createAp2AuthorizationProvider', 'createCheckoutJwt'])).toBe(
      '',
    );
  });

  it('shares one CommerceError class with the main entry', () => {
    // Built as independent bundles, each entry would carry its own copy and
    // `instanceof CommerceError` would be false across the seam. Turning off
    // tsup's `splitting` makes this fail.
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { CommerceError } from ${JSON.stringify(libEntry)};
         import { x402 } from ${JSON.stringify(x402Entry)};
         let caught;
         try { x402({ asset: 'not-an-address', payTo: '0x0', network: 'eip155:84532' }); }
         catch (e) { caught = e; }
         process.stdout.write(String(caught instanceof CommerceError));`,
      ],
      { encoding: 'utf8' },
    );
    expect(out).toBe('true');
  });
});
