/**
 * `agent-commerce demo` — a thin, honest wrapper around the documented
 * `docker compose up` + `npm run demo:agent` steps (README/ commands).
 *
 * No orchestration magic: each step's exit code is checked, and a failing
 * step is reported with exactly what failed and what to run to retry it, not
 * swallowed into a generic "demo failed" message.
 */
import type { Io } from '../lib/io.js';

export interface DemoStep {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Optional health check run after the step; returns true when healthy. */
  readonly healthCheck?: () => Promise<boolean>;
}

export interface RunResult {
  readonly code: number;
  readonly stderrTail?: string;
}

export type RunCommand = (command: string, args: readonly string[]) => Promise<RunResult>;

export interface DemoDeps {
  readonly run?: RunCommand;
  readonly steps?: readonly DemoStep[];
}

export function defaultDemoSteps(): readonly DemoStep[] {
  return [
    {
      name: 'Start local chain + gateway + merchant (docker compose)',
      command: 'docker',
      args: ['compose', 'up', '--build', '-d'],
    },
    { name: 'Run the deterministic buyer agent', command: 'npm', args: ['run', 'demo:agent'] },
  ];
}

/** `agent-commerce demo`. Returns process exit code. */
export async function runDemo(io: Io, deps: DemoDeps = {}): Promise<number> {
  const steps = deps.steps ?? defaultDemoSteps();
  const run = deps.run ?? execCommand;

  io.stdout('agent-commerce demo — running the documented quickstart steps:');
  for (const step of steps) {
    io.stdout('');
    io.stdout(`==> ${step.name}`);
    io.stdout(`    $ ${step.command} ${step.args.join(' ')}`);
    const result = await run(step.command, step.args);
    if (result.code !== 0) {
      io.stderr(`FAIL  "${step.name}" exited with code ${result.code}.`);
      if (result.stderrTail !== undefined && result.stderrTail.length > 0) {
        io.stderr(result.stderrTail);
      }
      io.stderr('');
      io.stderr('Nothing further was run. To retry manually:');
      io.stderr(`  ${step.command} ${step.args.join(' ')}`);
      return 1;
    }
    if (step.healthCheck !== undefined) {
      const healthy = await step.healthCheck();
      if (!healthy) {
        io.stderr(`FAIL  "${step.name}" completed but its health check did not pass.`);
        return 1;
      }
    }
    io.stdout(`OK    ${step.name}`);
  }
  io.stdout('');
  io.stdout('PASS  Demo is up. Try: agent-commerce doctor --config config-demo.yaml');
  return 0;
}

async function execCommand(command: string, args: readonly string[]): Promise<RunResult> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise) => {
    let stderr = '';
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolvePromise({ code: 1, stderrTail: err.message });
    });
    child.on('close', (code) => {
      const tail = stderr.trim().split('\n').slice(-10).join('\n');
      resolvePromise({ code: code ?? 1, ...(tail.length > 0 ? { stderrTail: tail } : {}) });
    });
  });
}
