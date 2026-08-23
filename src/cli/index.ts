#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program.js';

/**
 * `agent-commerce version | grep -q x402` is an ordinary thing to type, and
 * `grep -q` exits on its first match — closing the pipe while the CLI is still
 * writing. Node's default for that is an unhandled `EPIPE` error event on the
 * socket, which aborts the process with a stack trace: a command that did
 * exactly what was asked, reported as a crash, and a red CI step.
 *
 * Exit quietly instead. Every other stream error still throws.
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
