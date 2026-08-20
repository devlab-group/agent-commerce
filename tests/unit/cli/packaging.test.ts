/**
 * Packaging surface tests.
 *
 * The published npm artifact is the only thing an end user ever sees, and it
 * is built by a different path than everything else in the repo — so it can
 * break while every other test stays green. These assert the properties the
 * packaging spec requires, against the real built `dist/`.
 *
 * They skip (rather than fail) when `dist/` is absent, so `npm test` works on
 * a fresh clone before a build; CI runs `build:cli` first, so they execute
 * there. A skipped test is reported, never silently passed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Node builtins as they appear when imported without the `node:` prefix.
 * Shared by the import-surface assertions below, which would otherwise drift.
 */
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
 * Matches three forms, because missing one is how a dependency leak survives:
 * `import x from 'p'`, `export … from 'p'`, and the bare side-effect
 * `import 'p'`. That last form has no `from` clause; a pattern requiring one
 * reported the CLI as viem-free while the published binary refused to start
 * without viem installed. esbuild emits it for an external module whose
 * bindings tree-shook away but whose side effects it cannot prove absent.
 */
const bareImportsOf = (file: string): string[] => {
  const pattern = /^(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm;
  const packages = new Set<string>();
  const seen = new Set<string>();

  // follow relative imports. tsup builds the three library
  // entries with `splitting: true`, so shared code lives in `dist/chunk-*.js`.
  // Scanning only the entry file meant a peer import that migrated into a
  // shared chunk would pass this test while breaking a bare consumer install —
  // false confidence about the one invariant calls
  // non-negotiable.
  const visit = (path: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const spec = (match[1] ?? match[2]) as string;
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

describe('published package metadata', () => {
  it('is publishable — not marked private', () => {
    expect(manifest.private).toBeUndefined();
  });

  it('exposes the agent-commerce executable, pointing at compiled JS', () => {
    expect(manifest.bin?.['agent-commerce']).toBe('./dist/cli/index.js');
  });

  it('is not a workspace: no pnpm-workspace.yaml, and the root is publishable', () => {
    // The single-package refactor: architectural boundaries live in src/, not
    // in package manifests. A reappearing workspace file would mean the two
    // models are being run at once.
    expect(existsSync(resolve(pkgRoot, 'pnpm-workspace.yaml'))).toBe(false);
    expect(existsSync(resolve(pkgRoot, 'packages'))).toBe(false);
  });

  it('is an npm project: one npm lockfile, no pnpm lockfile', () => {
    // Two lockfiles is worse than either one: CI installs from whichever the
    // command picks, so the tree that was tested is not necessarily the tree
    // that was resolved. Docker and both CI workflows install with `npm ci`,
    // which fails outright without package-lock.json.
    expect(existsSync(resolve(pkgRoot, 'package-lock.json'))).toBe(true);
    expect(existsSync(resolve(pkgRoot, 'pnpm-lock.yaml'))).toBe(false);
  });

  it('pins zod through npm-native overrides', () => {
    // two zod majors in one graph break `instanceof` across module
    // boundaries. The pin moved twice (pnpm-workspace.yaml -> pnpm.overrides
    // -> overrides) and each move could silently drop it.
    expect(manifest.overrides?.['zod']).toBe(manifest.dependencies?.['zod']);
    expect(manifest.pnpm).toBeUndefined();
  });

  it('ships a library entry alongside the CLI', () => {
    const exportsField = manifest.exports as Record<string, unknown> | undefined;
    expect(exportsField?.['.']).toBeDefined();
  });

  it('gates the heavy adapters behind subpaths with optional peers', () => {
    // Installing `createGateway` used to pull x402's browser wallet stack:
    // 713 MB and 340 packages for a consumer serving a free HTTP resource.
    // These three are the whole weight (~665 MB) and none is needed by the
    // main entry or the CLI, so they are optional peers reached by subpath.
    const exportsField = manifest.exports as Record<string, unknown> | undefined;
    for (const subpath of ['./mcp', './x402']) {
      expect(exportsField?.[subpath]).toBeDefined();
    }
    for (const peer of ['@modelcontextprotocol/sdk', 'x402', 'viem']) {
      expect(manifest.peerDependencies?.[peer]).toBeDefined();
      expect(manifest.peerDependenciesMeta?.[peer]?.optional).toBe(true);
      // In `dependencies` too would defeat the point — npm installs those.
      expect(manifest.dependencies?.[peer]).toBeUndefined();
      //...but the repo itself still builds and tests against them.
      expect(manifest.devDependencies?.[peer]).toBe(manifest.peerDependencies?.[peer]);
    }
  });

  it('declares no workspace:* runtime dependency', () => {
    // Internal packages are bundled at build time, so they must not appear as
    // runtime dependencies — they are not published and npm could not resolve
    // them.
    const leaked = Object.entries(manifest.dependencies ?? {}).filter(([, v]) =>
      v.includes('workspace:'),
    );
    expect(leaked).toEqual([]);
  });

  it('publishes under the @devlab.group scope, explicitly public', () => {
    // A scoped package defaults to `restricted`. Without publishConfig.access
    // a `npm publish` either fails on a free account or silently publishes a
    // private package — the failure mode that looks like success.
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
    expect(manifest.files).toBeDefined();
    for (const entry of manifest.files ?? []) {
      expect(['dist', 'README.md', 'LICENSE']).toContain(entry);
    }
  });

  it('states its Node requirement', () => {
    expect(manifest.engines?.['node']).toBeDefined();
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

  it('reports real pinned versions, not the unresolved fallback', () => {
    // The published bundle has no sibling package.json files to read; the
    // build injects the resolved report. A regression here shows up as
    // "0.0.0-unknown" and an empty pinned list.
    const out = run('version');
    expect(out).not.toContain('0.0.0-unknown');
    expect(out).toContain('@modelcontextprotocol/sdk');
    expect(out).toContain('x402');
  });

  it('offers every documented command', () => {
    const help = run('--help');
    for (const command of ['init', 'validate', 'doctor', 'demo', 'version']) {
      expect(help).toContain(command);
    }
  });

  it('imports nothing from the repo source tree', () => {
    const source = readFileSync(distEntry, 'utf8');
    expect(source).not.toMatch(/from\s*['"][^'"]*packages\/(core|config|gateway)\//);
  });

  it('resolves its own version without reading a manifest by relative path', () => {
    // Bundling collapses src/**'s directory depth into two files, so any
    // `require('../../../package.json')` written against a source path
    // resolves from the wrong depth once bundled. That is not hypothetical:
    // it broke both entry points during the single-package refactor, and
    // before that produced a CLI reporting "0.0.0-unknown" the same way.
    // The version is injected at build time instead (tsup.config.ts).
    for (const entry of [distEntry, libEntry]) {
      expect(readFileSync(entry, 'utf8')).not.toMatch(
        /require\(['"]\.\.?\/[^'"]*package\.json['"]\)/,
      );
    }
  });

  it('leaves only npm-resolvable modules as imports', () => {
    // `dependencies` only — not the optional peers. The binary must run on a
    // default `npm i @devlab.group/agent-commerce`, with nothing else installed.
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const pkg of bareImportsOf(distEntry)) {
      expect(declared).toContain(pkg);
    }
  });
});

describe.skipIf(!existsSync(libEntry))('built library entry', () => {
  // `import { createGateway } from "@devlab.group/agent-commerce"` is half the public
  // contract and is built by the same path as the CLI, so it fails the same
  // ways. Loaded in a subprocess: an import failure must surface as a failed
  // assertion here, not as a crash of the test runner.
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
    // They moved to `@devlab.group/agent-commerce/mcp` and `/x402`. Re-exporting them
    // here would statically import x402 and the MCP SDK from the main entry,
    // which is precisely what makes the peers non-optional again — a bare
    // install would fail on `import { createGateway }`.
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
    expect(version).not.toContain('0.0.0-unknown');
    expect(version).toBe(
      (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string })
        .version,
    );
  });
});

describe.skipIf(!existsSync(libEntry))('optional-peer subpaths', () => {
  const mcpEntry = join(pkgRoot, 'dist', 'mcp.js');
  const x402Entry = join(pkgRoot, 'dist', 'x402.js');

  it('keeps every optional peer out of the main entry and the CLI', () => {
    // The load-bearing assertion of the whole split: if an optional peer is
    // imported by either always-installed entry, a bare install is broken.
    const peers = Object.keys(
      (
        JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
          peerDependencies?: Record<string, string>;
        }
      ).peerDependencies ?? {},
    );
    expect(peers.length).toBeGreaterThan(0);
    for (const entry of [libEntry, distEntry]) {
      expect(bareImportsOf(entry).filter((pkg) => peers.includes(pkg))).toEqual([]);
    }
  });

  it('imports only its own peer, in each subpath', () => {
    expect(bareImportsOf(mcpEntry)).toEqual(['@modelcontextprotocol/sdk']);
    expect(bareImportsOf(x402Entry).sort()).toEqual(['viem', 'x402']);
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
  });

  it('shares one CommerceError class with the main entry', () => {
    // Built as independent bundles each entry carries its own copy, and
    // `catch (e) { e instanceof CommerceError }` is false across the seam —
    // verified: flipping tsup's `splitting` off makes this assertion fail.
    // Same class of defect described for two zod majors.
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { CommerceError } from ${JSON.stringify(libEntry)};
         import { x402 } from ${JSON.stringify(x402Entry)};
         let caught;
         try { x402({ asset: 'not-an-address', payTo: '0x0', network: 'base-sepolia' }); }
         catch (e) { caught = e; }
         process.stdout.write(String(caught instanceof CommerceError));`,
      ],
      { encoding: 'utf8' },
    );
    expect(out).toBe('true');
  });
});
