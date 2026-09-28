import { describe, expect, it } from 'vitest';
import { defaultDemoSteps, runDemo } from '../../../src/cli/commands/demo';
import { createCapturingIo } from './fixtures';

describe('runDemo', () => {
  it('runs every step and reports success when all steps succeed', async () => {
    const io = createCapturingIo();
    const calls: string[] = [];

    const code = await runDemo(io, {
      run: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        return { code: 0 };
      },
    });

    expect(code).toBe(0);
    expect(calls.length).toBe(defaultDemoSteps().length);
    expect(io.out.join('\n')).toContain('Demo is up');
  });

  it('stops at the first failing step and reports exactly which one, without running later steps', async () => {
    const io = createCapturingIo();
    const calls: string[] = [];

    const code = await runDemo(io, {
      steps: [
        { name: 'Step one', command: 'cmd1', args: ['a'] },
        { name: 'Step two', command: 'cmd2', args: ['b'] },
      ],
      run: async (command) => {
        calls.push(command);
        if (command === 'cmd1') {
          return { code: 7, stderrTail: 'boom' };
        }
        return { code: 0 };
      },
    });

    expect(code).toBe(1);
    expect(calls).toEqual(['cmd1']); // cmd2 never ran
    expect(io.err.join('\n')).toContain('Step one');
    expect(io.err.join('\n')).toContain('exited with code 7');
    expect(io.err.join('\n')).toContain('boom');
    expect(io.err.join('\n')).toContain('cmd1 a'); // exact retry command shown
  });

  it('exposes the documented default steps (docker compose + demo:agent)', () => {
    const steps = defaultDemoSteps();
    expect(steps.map((s) => s.command)).toEqual(['docker', 'npm']);
    // --wait is what holds the agent back until the services are healthy
    expect(steps[0]?.args).toContain('--wait');
    expect(steps[1]?.args).toEqual(['run', 'demo:agent']);
  });
});

describe('runDemo - real process execution (default execCommand, no `run` injected)', () => {
  it('reports success for a real command that exits 0', async () => {
    const io = createCapturingIo();
    const code = await runDemo(io, {
      steps: [{ name: 'Say ok', command: 'node', args: ['-e', 'process.exit(0)'] }],
    });
    expect(code).toBe(0);
  });

  it('captures a stderr tail and reports the exact exit code for a failing real command', async () => {
    const io = createCapturingIo();
    const code = await runDemo(io, {
      steps: [
        {
          name: 'Fail loudly',
          command: 'node',
          args: ['-e', 'console.error("kaboom"); process.exit(3)'],
        },
      ],
    });
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('exited with code 3');
    expect(io.err.join('\n')).toContain('kaboom');
  });

  it('reports failure when the command itself cannot be spawned (ENOENT)', async () => {
    const io = createCapturingIo();
    const code = await runDemo(io, {
      steps: [
        { name: 'Nonexistent binary', command: 'definitely-not-a-real-binary-xyz', args: [] },
      ],
    });
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('Nonexistent binary');
  });
});
