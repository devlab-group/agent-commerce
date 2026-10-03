import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json' with { type: 'json' };
import { runVersion } from '../../../src/cli/commands/version';
import { createCapturingIo } from './fixtures';

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

  it('prints each pinned version exactly as package.json declares it', () => {
    const io = createCapturingIo();
    runVersion(io);
    const joined = io.out.join('\n');
    expect(joined).toContain('Pinned protocol / SDK versions:');
    const declared: Record<string, string | undefined> = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
    };
    const printed = io.out.flatMap((line) => {
      const match = /^ {2}(\S+)\s+(\S+)\s+\(via /.exec(line);
      return match ? [[match[1] ?? '', match[2]] as const] : [];
    });
    expect(printed.length).toBeGreaterThan(0);
    for (const [name, version] of printed) {
      expect(version, name).toBe(declared[name]);
    }
    expect(joined).toMatch(/@modelcontextprotocol\/sdk\s+1\.32\.0/);
    expect(joined).toMatch(/@x402\/core\s+2\.25\.0/);
    expect(joined).toMatch(/@x402\/evm\s+2\.25\.0/);
    expect(joined).toMatch(/better-sqlite3\s+13\.0\.3/);
  });

  it('also reports the MPP, AP2, ACP and OpenAPI import pins', () => {
    const io = createCapturingIo();
    runVersion(io);
    const joined = io.out.join('\n');
    for (const name of [
      'mppx',
      'jose',
      '@sd-jwt/core',
      'canonicalize',
      'ajv',
      'ajv-formats',
      '@scalar/openapi-parser',
    ]) {
      expect(joined).toMatch(new RegExp(`^  ${name.replace('/', '\\/')}\\s`, 'm'));
    }
  });
});
