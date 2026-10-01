/**
 * The CLI version (`PACKAGE_VERSION`) and the pinned protocol/SDK versions.
 * The pins come from a static JSON import of package.json, which tsup inlines,
 * so the bundle never reads the manifest by relative path.
 */
import manifest from '../../../package.json' with { type: 'json' };
import { PACKAGE_VERSION } from '../../version';

export interface PinnedVersion {
  readonly name: string;
  readonly version: string;
  readonly via: string;
}

export interface VersionReport {
  readonly cliVersion: string;
  readonly pinned: readonly PinnedVersion[];
}

// The protocol/SDK pins (the A2A SDK is test-only, so it is not listed), each
// with the main src/ directory that uses it
const PINS: readonly (readonly [name: string, via: string])[] = [
  ['@modelcontextprotocol/sdk', 'protocols/mcp'],
  ['ajv', 'protocols/acp'],
  ['ajv-formats', 'protocols/acp'],
  ['@x402/core', 'payments/x402'],
  ['@x402/evm', 'payments/x402'],
  ['@coinbase/x402', 'payments/x402'],
  ['viem', 'payments/x402'],
  ['mppx', 'payments/mpp'],
  ['jose', 'authorization/ap2'],
  ['@sd-jwt/core', 'authorization/ap2'],
  ['canonicalize', 'authorization/ap2'],
  ['@scalar/openapi-parser', 'openapi'],
  ['zod', 'config'],
  ['fastify', 'gateway'],
  ['pino', 'gateway'],
  ['better-sqlite3', 'storage'],
];

/** Pins missing from the manifest are left out rather than shown as "unknown" */
export function readVersionReport(): VersionReport {
  // Optional peers count as pins; a package in both lists reports its dependency
  const declared: Readonly<Record<string, string | undefined>> = {
    ...manifest.peerDependencies,
    ...manifest.dependencies,
  };
  const pinned = PINS.flatMap(([name, via]) => {
    const version = declared[name];
    return version === undefined ? [] : [{ name, version, via }];
  });
  return { cliVersion: PACKAGE_VERSION, pinned };
}
