/**
 * `.deploy/local.json` reader — canonical import per docs/contracts.md.
 *
 * Always resolves relative to the repo root computed from *this file's own
 * location*, never `process.cwd()` — demo-agent is normally invoked via
 * `npm run demo:agent`, whose cwd is this
 * package's directory, not the repo root.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type LocalChainManifest,
  readLocalChainManifest,
} from '../../../src/payments/x402/testing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

export type { LocalChainManifest };

/** Reads `.deploy/local.json`. Throws a clear, actionable error if absent. */
export function loadLocalChainManifest(): LocalChainManifest {
  return readLocalChainManifest(REPO_ROOT);
}
