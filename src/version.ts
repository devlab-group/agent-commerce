/**
 * The package version, resolved once for the whole package.
 *
 * The build injects `__OAC_PACKAGE_VERSION__` (tsup.config.ts), because a
 * relative manifest path resolves from the wrong depth once `src/**` is
 * bundled. From source, the root manifest is read instead. `typeof` on an
 * undeclared identifier is safe, so the source path runs without the constant.
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
