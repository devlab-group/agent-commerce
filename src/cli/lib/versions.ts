/**
 * The CLI's own version and every pinned protocol/SDK version — never
 * hard-coded, so a pin bump (see docs/contracts.md) is reflected automatically.
 *
 * Two resolution paths, deliberately:
 *
 *  - **Development** reads the root manifest directly, so the numbers are
 *    always live.
 *  - **The published npm package** cannot: the build collapses `src/**` into
 *    two bundled files, so a relative manifest path written against a source
 *    location resolves from the wrong depth once bundled. That has now failed
 *    twice — it silently produced `v0.0.0-unknown` before packaging, and it
 *    crashed both entry points during the single-package refactor. So the
 *    build injects the resolved report as `__OAC_VERSION_REPORT__` (see
 *    tsup.config.ts) and it is preferred when present.
 *
 * `typeof` on an undeclared identifier is safe in JS, so the dev path is
 * unaffected by the constant not existing.
 */
import { createRequire } from 'node:module';

declare const __OAC_VERSION_REPORT__: string | undefined;

const require = createRequire(import.meta.url);

interface PackageManifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

function readManifest(relativePath: string): PackageManifest | undefined {
  try {
    return require(relativePath) as PackageManifest;
  } catch {
    return undefined;
  }
}

/**
 * Peers count as pins. The three heaviest pins — the MCP SDK, x402 and viem —
 * are *optional peer* dependencies so a default install stays small, and
 * reading only `dependencies` silently emptied this report of exactly the
 * protocol/SDK versions it exists to show.
 */
function depVersion(manifest: PackageManifest | undefined, name: string): string | undefined {
  return manifest?.dependencies?.[name] ?? manifest?.peerDependencies?.[name];
}

export interface PinnedVersion {
  readonly name: string;
  readonly version: string;
  readonly via: string;
}

export interface VersionReport {
  readonly cliVersion: string;
  readonly pinned: readonly PinnedVersion[];
}

/** Missing entries are omitted (rather than shown as "unknown") so nothing is ever fabricated. */
export function readVersionReport(): VersionReport {
  const injected = typeof __OAC_VERSION_REPORT__ === 'string' ? __OAC_VERSION_REPORT__ : undefined;
  if (injected !== undefined) {
    return JSON.parse(injected) as VersionReport;
  }

  // One package, one manifest. `via` names the module that owns each pin,
  // which is what a reader of `agent-commerce version` actually wants to know;
  // the names are src/ directories, not package manifests.
  const manifest = readManifest('../../../package.json');

  const candidates: readonly [string, string][] = [
    ['@modelcontextprotocol/sdk', 'protocols/mcp'],
    ['@x402/core', 'payments/x402'],
    ['@x402/evm', 'payments/x402'],
    ['viem', 'payments/x402'],
    ['better-sqlite3', 'storage/receipts'],
    ['fastify', 'gateway'],
    ['pino', 'gateway'],
    ['zod', 'config'],
  ];

  const pinned: PinnedVersion[] = [];
  for (const [name, via] of candidates) {
    const version = depVersion(manifest, name);
    if (version !== undefined) {
      pinned.push({ name, version, via });
    }
  }

  return {
    cliVersion: manifest?.version ?? '0.0.0-unknown',
    pinned,
  };
}
