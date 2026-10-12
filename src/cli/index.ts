#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program';

// Set when `start` runs, which serves until a signal rather than finishing
let serving = false;

// A reader such as `grep -q` can close the pipe before the CLI finishes writing.
// Exit quietly on EPIPE for finite commands. Keep `start` serving: exiting would
// invoke pino's synchronous flush, whose sonic-boom retry loop hangs on EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
    if (!serving) process.exit(0);
  });
}

async function main(): Promise<void> {
  const program = buildProgram();
  program.hook('preAction', (_program, command) => {
    serving = command.name() === 'start';
  });
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
