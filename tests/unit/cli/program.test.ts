import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { createCapturingIo } from '../../../src/cli/lib/io.js';
import { buildProgram } from '../../../src/cli/program.js';

/**
 * Runs the program the same way index.ts does (exitOverride + a catch that
 * turns CommanderError into process.exitCode), but saves/restores
 * process.exitCode around the call so a test never leaks it into vitest's own
 * process exit status.
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
    for (const command of ['version', 'validate', 'doctor', 'init', 'demo']) {
      expect(text).toContain(command);
    }
  });

  it.each(['version', 'validate', 'doctor', 'init', 'demo'])(
    '%s --help exits 0 and prints its description',
    async (command) => {
      const { exitCode, io } = await run([command, '--help']);
      expect(exitCode).toBe(0);
      expect(io.out.join('\n').length).toBeGreaterThan(0);
    },
  );

  it('an unknown command exits non-zero', async () => {
    const { exitCode } = await run(['not-a-real-command']);
    expect(exitCode).not.toBe(0);
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
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed.exitCode).toBe(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe('agent-commerce init', () => {
  it('--yes writes a valid config through the real program wiring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-commerce-program-init-'));
    const outputPath = join(dir, 'config.yaml');

    const { exitCode, io } = await run(['init', '--yes', '--output', outputPath]);

    expect(exitCode).toBe(0);
    expect(io.out.join('\n')).toContain('Wrote');
  });
});

afterEach(() => {
  // Defensive: never let a failed assertion above leave process.exitCode set
  // for the rest of the suite.
  process.exitCode = undefined;
});
