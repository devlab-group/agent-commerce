import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadLocalChainManifest } from '../src/chain-manifest';

// The reader has its own tests (tests/unit/payments-x402/manifest.test.ts);
// this checks only which root the demo passes it
vi.mock('../../../src/payments/x402/testing', () => ({
  readLocalChainManifest: (root: string) => root,
}));

describe('loadLocalChainManifest', () => {
  it('reads from the repository root, not the working directory', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    expect(loadLocalChainManifest()).toBe(repoRoot);
  });
});
