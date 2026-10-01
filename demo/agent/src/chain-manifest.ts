/**
 * Reads `.deploy/local.json` (docs/contracts.md, "Local chain deployment
 * manifest"). The repository root comes from this file's location, not
 * `process.cwd()`, so the agent finds the manifest from any working directory.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type LocalChainManifest,
  readLocalChainManifest,
} from '../../../src/payments/x402/testing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

export type { LocalChainManifest };

/** Reads `.deploy/local.json`. Throws an error naming `npm run chain:deploy` if it is absent */
export function loadLocalChainManifest(): LocalChainManifest {
  return readLocalChainManifest(REPO_ROOT);
}
