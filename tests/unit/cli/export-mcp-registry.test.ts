// `agent-commerce export mcp-registry`: what it writes, and when it writes nothing
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runExportMcpRegistry } from '../../../src/cli/commands/export-mcp-registry';
import type { GatewayConfig } from '../../../src/cli/lib/config-client';
import { CommerceError } from '../../../src/core';
import { createCapturingIo, makeGatewayConfig } from './fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function outputPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-commerce-export-'));
  dirs.push(dir);
  return join(dir, 'server.json');
}

const REGISTRY = {
  name: 'io.github.acme/weather',
  version: '2.0.1',
  description: 'Weather forecasts, paid per call',
};

function config(mcp: GatewayConfig['protocols']['mcp']): GatewayConfig {
  const base = makeGatewayConfig();
  return makeGatewayConfig({
    merchant: { ...base.merchant, publicBaseUrl: 'https://api.example.com' },
    protocols: { ...base.protocols, mcp },
  });
}
const LISTABLE = config({ enabled: true, mountPath: '/mcp', registry: REGISTRY });

async function run(
  options: { output: string; force?: boolean },
  loadConfig: () => Promise<GatewayConfig> = async () => LISTABLE,
) {
  const io = createCapturingIo();
  const load = vi.fn(loadConfig);
  const code = await runExportMcpRegistry(options, io, { loadConfig: load });
  return { code, io, load };
}

describe('export mcp-registry', () => {
  it('writes server.json with $schema first and reports the listing', async () => {
    const output = outputPath();

    const { code, io } = await run({ output });

    expect(code).toBe(0);
    const content = readFileSync(output, 'utf8');
    expect(JSON.parse(content)).toEqual({
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: 'io.github.acme/weather',
      description: 'Weather forecasts, paid per call',
      version: '2.0.1',
      remotes: [{ type: 'streamable-http', url: 'https://api.example.com/mcp' }],
    });
    expect(content.startsWith('{\n  "$schema": ')).toBe(true);
    expect(content.endsWith('}\n')).toBe(true);
    expect(io.out).toEqual([
      `Wrote ${output} for io.github.acme/weather 2.0.1.`,
      'Publish it with mcp-publisher after verifying the namespace.',
    ]);
    expect(io.err).toEqual([]);
  });

  it('refuses an existing file without --force, before reading config', async () => {
    const output = outputPath();
    writeFileSync(output, 'keep me\n', 'utf8');

    const { code, io, load } = await run({ output });

    expect(code).toBe(1);
    expect(io.err).toEqual([`FAIL  ${output} already exists. Re-run with --force to overwrite.`]);
    expect(readFileSync(output, 'utf8')).toBe('keep me\n');
    expect(load).not.toHaveBeenCalled();
  });

  it('replaces an existing file with --force', async () => {
    const output = outputPath();
    writeFileSync(output, 'replace me\n', 'utf8');

    const { code } = await run({ output, force: true });

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ version: '2.0.1' });
  });

  it('writes nothing when a registry rule fails, naming each key', async () => {
    const output = outputPath();

    const { code, io } = await run({ output }, async () =>
      config({ enabled: false, mountPath: '/mcp' }),
    );

    expect(code).toBe(1);
    expect(io.err).toEqual([
      'FAIL  protocols.mcp.enabled is false: the listing would name a server that does not run',
      'FAIL  protocols.mcp.registry is not set: it holds the listing name, version and description',
    ]);
    expect(existsSync(output)).toBe(false);
  });

  it('fails naming the path when the file cannot be written', async () => {
    // A regular file where the output directory should be
    const blocker = outputPath();
    writeFileSync(blocker, 'not a directory\n', 'utf8');
    const output = join(blocker, 'server.json');

    const { code, io } = await run({ output });

    expect(code).toBe(1);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(new RegExp(`^FAIL  ${output} could not be written: `));
    expect(io.out).toEqual([]);
  });

  it('writes nothing when config fails to load', async () => {
    const output = outputPath();

    const { code, io } = await run({ output }, async () => {
      throw new CommerceError('CONFIG_INVALID', 'Configuration invalid at "protocols.mcp"', {
        details: { path: 'protocols.mcp' },
      });
    });

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain(
      'FAIL  CONFIG_INVALID: Configuration invalid at "protocols.mcp"',
    );
    expect(existsSync(output)).toBe(false);
  });
});
