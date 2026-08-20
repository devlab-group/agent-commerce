/**
 * The package version, resolved once for the whole package.
 *
 * Two paths, deliberately:
 *
 * - **Development** reads the root manifest, so the number is always live.
 * - **The published bundle cannot.** tsup collapses `src/**` into
 * `dist/index.js` and `dist/cli/index.js`, so any `require('../../package.json')`
 * written against a source path resolves from the wrong depth once bundled —
 * which is exactly how this broke during the single-package refactor, and how
 * it earlier produced a CLI reporting `v0.0.0-unknown`. The build injects
 * `__OAC_PACKAGE_VERSION__` instead (see tsup.config.ts).
 *
 * `typeof` on an undeclared identifier is safe in JS, so the dev path is
 * unaffected by the constant not existing.
 */
import { createRequire } from 'node:module';

declare const __OAC_PACKAGE_VERSION__: string | undefined;

function readFromManifest(): string {
  try {
    const require = createRequire(import.meta.url);
    // src/version.ts -> repository root
    return (require('../package.json') as { version?: string }).version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

export const PACKAGE_VERSION: string =
  typeof __OAC_PACKAGE_VERSION__ === 'string' ? __OAC_PACKAGE_VERSION__ : readFromManifest();
