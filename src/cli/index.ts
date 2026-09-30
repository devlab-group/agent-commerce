#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program';

/**
 * `agent-commerce version | grep -q x402` closes the pipe on grep's first
 * match while the CLI is still writing. Node reports that as an unhandled
 * `EPIPE` error and aborts with a stack trace, so a command that did what was
 * asked would read as a crash. Exit quietly on `EPIPE`; any other stream error
 * still throws.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
      return;
    }
    throw err;
  }
}

void main();
