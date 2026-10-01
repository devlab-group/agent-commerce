import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { DoctorReport } from '../../../src/cli/commands/doctor';
import { buildProgram } from '../../../src/cli/program';
import { createCapturingIo } from './fixtures';

/**
 * Runs the program the same way index.ts does (exitOverride + a catch that
 * turns CommanderError into process.exitCode), but saves/restores
 * process.exitCode around the call so a test never leaks it into vitest's own
 * process exit status
 */
async function run(argv: readonly string[], io = createCapturingIo()) {
  const program = buildProgram(io);
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
    } else {
      process.exitCode = savedExitCode;
      throw err;
    }
  }
  const exitCode = process.exitCode;
  process.exitCode = savedExitCode;
  return { exitCode, io };
}

describe('agent-commerce --help', () => {
  it('prints top-level usage and every subcommand, exit code 0', async () => {
    const { exitCode, io } = await run(['--help']);
    const text = io.out.join('\n');
    expect(exitCode).toBe(0);
    expect(text).toContain('Usage: agent-commerce');
    for (const command of ['version', 'validate', 'doctor', 'init', 'import', 'demo']) {
      expect(text).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
  });

  it.each(['version', 'validate', 'doctor', 'init', 'demo'])(
    '%s --help exits 0 and prints its usage',
    async (command) => {
      const { exitCode, io } = await run([command, '--help']);
      expect(exitCode).toBe(0);
      expect(io.out.join('\n')).toContain(`Usage: agent-commerce ${command}`);
    },
  );

  it.each([
    [['not-a-real-command'], "unknown command 'not-a-real-command'"],
    [['validate', '--bogus'], "unknown option '--bogus'"],
  ])('%j exits 1 and names the problem', async (argv, message) => {
    const { exitCode, io } = await run(argv);
    expect(exitCode).toBe(1);
    expect(io.err.join('\n')).toContain(message);
  });
});

describe('agent-commerce version', () => {
  it('prints the version and exits 0', async () => {
    const { exitCode, io } = await run(['version']);
    expect(exitCode).toBe(0);
    expect(io.out.join('\n')).toMatch(/agent-commerce v\d+\.\d+\.\d+/);
  });
});

describe('agent-commerce validate', () => {
  it('exits 0 for a valid config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-commerce-program-'));
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      `
version: 1
merchant: { id: demo, name: Demo, publicBaseUrl: http://localhost:8080 }
server: { port: 8080, host: 0.0.0.0 }
storage: { receipts: { driver: sqlite, path: ./data/receipts.db } }
protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: /mcp } }
resources: {}
payments: {}
`,
      'utf8',
    );

    const { exitCode, io } = await run(['validate', '--config', configPath]);
    expect(exitCode).toBe(0);
    expect(io.out.join('\n')).toContain('PASS');
  });

  it('exits 1 for a missing config file', async () => {
    const { exitCode, io } = await run(['validate', '--config', '/does/not/exist.yaml']);
    expect(exitCode).toBe(1);
    expect(io.err.join('\n')).toContain('FAIL');
  });
});

describe('agent-commerce doctor', () => {
  it('exits 1 and emits JSON when the gateway is unreachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-commerce-program-'));
    const configPath = join(dir, 'config.yaml');
    const dbPath = join(dir, 'receipts.db').replace(/\\/g, '/');
    writeFileSync(
      configPath,
      `
version: 1
merchant: { id: demo, name: Demo, publicBaseUrl: http://localhost:8080 }
server: { port: 8080, host: 0.0.0.0 }
storage: { receipts: { driver: sqlite, path: "${dbPath}" } }
protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: /mcp } }
resources: {}
payments: {}
`,
      'utf8',
    );

    const { exitCode, io } = await run([
      'doctor',
      '--config',
      configPath,
      '--gateway',
      'http://127.0.0.1:1',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(io.out.join('')) as DoctorReport;
    expect(parsed.exitCode).toBe(1);
    // The file at --config was read, so the failure is the gateway's alone
    expect(parsed.checks.find((c) => c.name === 'Config')?.status).toBe('PASS');
    expect(parsed.checks.find((c) => c.name === 'Gateway')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('unreachable at http://127.0.0.1:1'),
    });
  });
});

describe('agent-commerce init', () => {
  const tmpConfigPath = () =>
    join(mkdtempSync(join(tmpdir(), 'agent-commerce-program-init-')), 'config.yaml');

  it('--yes writes a valid config through the real program wiring', async () => {
    const outputPath = tmpConfigPath();

    const { exitCode, io } = await run(['init', '--yes', '--output', outputPath]);

    expect(exitCode).toBe(0);
    expect(io.out.join('\n')).toContain(`Wrote ${outputPath}`);
    expect(readFileSync(outputPath, 'utf8')).toContain('Generated by `agent-commerce init`');
  });

  it('overwrites an existing file only with --force', async () => {
    const outputPath = tmpConfigPath();
    writeFileSync(outputPath, 'keep me\n', 'utf8');

    const refused = await run(['init', '--yes', '--output', outputPath]);
    expect(refused.exitCode).toBe(1);
    expect(readFileSync(outputPath, 'utf8')).toBe('keep me\n');

    const forced = await run(['init', '--yes', '--force', '--output', outputPath]);
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toContain('Generated by `agent-commerce init`');
  });
});

describe('agent-commerce import openapi', () => {
  const source = fileURLToPath(new URL('../openapi/fixtures/responses-3.1.yaml', import.meta.url));
  const tmpOutput = () =>
    join(mkdtempSync(join(tmpdir(), 'agent-commerce-program-import-')), 'out.yaml');

  it('passes every option through to the importer', async () => {
    const output = tmpOutput();

    const { exitCode } = await run([
      'import',
      'openapi',
      source,
      '--output',
      output,
      '--operation',
      'getOrder',
      '--operation',
      'cancelOrder',
      '--free',
      '--expose',
      'http',
      '--base-url',
      'https://backend.internal',
    ]);

    expect(exitCode).toBe(0);
    const { resources } = parseYaml(readFileSync(output, 'utf8')) as {
      resources: Record<string, unknown>;
    };
    expect(Object.keys(resources).sort()).toEqual(['cancelOrder', 'getOrder']);
    expect(resources['getOrder']).toMatchObject({
      pricing: { type: 'free' },
      expose: ['http'],
      backend: { url: 'https://backend.internal/orders/{orderId}' },
    });
  });

  it('exits 1 under --strict when the import produced warnings, writing nothing', async () => {
    const output = tmpOutput();

    const { exitCode } = await run(['import', 'openapi', source, '--output', output, '--strict']);

    expect(exitCode).toBe(1);
    expect(existsSync(output)).toBe(false);
  });
});

afterEach(() => {
  // Defensive: never let a failed assertion above leave process.exitCode set
  // for the rest of the suite
  process.exitCode = undefined;
});
