#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program.js';

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
