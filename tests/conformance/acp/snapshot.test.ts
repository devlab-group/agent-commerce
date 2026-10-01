/**
 * The vendored ACP schema and examples are upstream's bytes, not ours.
 *
 * The gateway validates against the schema and the conformance suite sends the
 * examples, so an edit to either would let server and tests agree while both
 * drift from the protocol. Each file is pinned to its git blob hash at the
 * upstream commit recorded in src/protocols/acp/spec/2026-04-17/README.md;
 * `git ls-tree -r <commit>` in the upstream repository prints the same hashes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The id git gives a file: sha1 over "blob <size>\0" and the content
function gitBlobHash(path: string): string {
  const content = readFileSync(path);
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

describe('ACP 2026-04-17 snapshot', () => {
  it.each([
    [
      'src/protocols/acp/spec/2026-04-17/schema.agentic_checkout.json',
      'spec/2026-04-17/json-schema/schema.agentic_checkout.json',
      '9c019241c3340fbf8ba567dc5e2e4159f67337db',
    ],
    [
      'tests/fixtures/acp/2026-04-17/examples.agentic_checkout.json',
      'examples/2026-04-17/examples.agentic_checkout.json',
      '94ed4b84fe96996a838fb0e69d7697db5135b746',
    ],
  ])('%s is upstream %s at commit 6b82868', (local, _upstream, blob) => {
    expect(gitBlobHash(local)).toBe(blob);
  });
});
