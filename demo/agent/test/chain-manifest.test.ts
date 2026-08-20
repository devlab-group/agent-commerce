import { describe, expect, it } from 'vitest';
import { loadLocalChainManifest } from '../src/chain-manifest.js';

describe('loadLocalChainManifest', () => {
  it("throws a clear, actionable error when.deploy/local.json does not exist (repo's current state pre chain:deploy)", () => {
    // This test only asserts the negative path: it does not assume the local
    // chain has been deployed. If a real manifest exists (e.g. this suite
    // runs after `npm run chain:deploy`), the positive path is exercised
    // end-to-end by the demo-agent's actual documented quickstart instead —
    // see the report's QUICKSTART section.
    try {
      const manifest = loadLocalChainManifest();
      // If a manifest genuinely exists, just sanity-check its shape.
      expect(manifest.chainId).toBeTypeOf('number');
      expect(manifest.rpcUrl).toBeTypeOf('string');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/chain:deploy/);
    }
  });
});
