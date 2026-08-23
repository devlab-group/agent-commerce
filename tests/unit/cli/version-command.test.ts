import { describe, expect, it } from 'vitest';
import { runVersion } from '../../../src/cli/commands/version.js';
import { createCapturingIo } from '../../../src/cli/lib/io.js';

describe('runVersion', () => {
  it('prints only the version line when there are no pinned versions to report', () => {
    const io = createCapturingIo();
    const code = runVersion(io, {
      readVersionReport: () => ({ cliVersion: '9.9.9', pinned: [] }),
    });
    expect(code).toBe(0);
    expect(io.out).toEqual(['agent-commerce v9.9.9']);
  });

  it('prints the CLI version and returns exit code 0', () => {
    const io = createCapturingIo();
    const code = runVersion(io);
    expect(code).toBe(0);
    expect(io.out[0]).toMatch(/^agent-commerce v\d+\.\d+\.\d+/);
  });

  it('prints pinned protocol/SDK versions read from installed manifests, not hard-coded', () => {
    const io = createCapturingIo();
    runVersion(io);
    const joined = io.out.join('\n');
    expect(joined).toContain('Pinned protocol / SDK versions:');
    // These come from sibling package.json files, not literals in the source.
    expect(joined).toMatch(/@modelcontextprotocol\/sdk\s+1\.30\.0/);
    expect(joined).toMatch(/@x402\/core\s+2\.23\.0/);
    expect(joined).toMatch(/@x402\/evm\s+2\.23\.0/);
    expect(joined).toMatch(/better-sqlite3\s+13\.0\.3/);
  });
});
