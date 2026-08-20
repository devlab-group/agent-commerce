import { Command } from 'commander';
import { DEFAULT_CONFIG_FILENAME } from '../config/filename.js';
import { runDemo } from './commands/demo.js';
import { printDoctorReport, runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runValidate } from './commands/validate.js';
import { runVersion } from './commands/version.js';
import { type Io, processIo } from './lib/io.js';
import { readVersionReport } from './lib/versions.js';

/**
 * Builds the `agent-commerce` Commander program.
 *
 * `io` is injectable so tests can capture output instead of writing to the
 * real process streams; `exitOverride()` + `configureOutput()` mean
 * `--help`/errors never call `process.exit()` directly, so a caller (index.ts
 * or a test) fully controls process lifecycle.
 */
export function buildProgram(io: Io = processIo): Command {
  const program = new Command();

  program
    .name('agent-commerce')
    .description('CLI for the Agent Commerce Gateway: init, validate, doctor, demo.')
    // `--version` is required of the published binary. The `version`
    // subcommand stays: it additionally prints the pinned protocol/SDK
    // versions, which is what `doctor` and the support matrix are checked
    // against. Both read the same source, so they cannot disagree.
    .version(readVersionReport().cliVersion, '-v, --version', 'Print the CLI version.')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout(str.replace(/\n+$/, '')),
      writeErr: (str) => io.stderr(str.replace(/\n+$/, '')),
    });

  program
    .command('version')
    .description('Print the CLI version and pinned protocol/SDK versions.')
    .action(() => {
      process.exitCode = runVersion(io);
    });

  program
    .command('validate')
    .description(`Validate ${DEFAULT_CONFIG_FILENAME} and exit non-zero if it is invalid.`)
    .option('--config <path>', `path to ${DEFAULT_CONFIG_FILENAME}`)
    .action(async (opts: { config?: string }) => {
      const code = await runValidate(
        opts.config !== undefined ? { configPath: opts.config } : {},
        io,
      );
      process.exitCode = code;
    });

  program
    .command('doctor')
    .description('Diagnose config, gateway, backend, protocol and payment health.')
    .option('--config <path>', `path to ${DEFAULT_CONFIG_FILENAME}`)
    .option(
      '--gateway <url>',
      'gateway base URL (default: derived from config, else http://localhost:8080)',
    )
    .option('--json', 'emit machine-readable JSON instead of a formatted report', false)
    .action(async (opts: { config?: string; gateway?: string; json?: boolean }) => {
      const report = await runDoctor({
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(opts.gateway !== undefined ? { gatewayUrl: opts.gateway } : {}),
      });
      printDoctorReport(report, io, opts.json === true);
      process.exitCode = report.exitCode;
    });

  program
    .command('init')
    .description(`Interactively generate ${DEFAULT_CONFIG_FILENAME}.`)
    .option('--output <path>', 'output path', DEFAULT_CONFIG_FILENAME)
    .option('--force', 'overwrite an existing file', false)
    .option('--yes', 'use non-interactive defaults (required for scripting/tests)', false)
    .action(async (opts: { output: string; force: boolean; yes: boolean }) => {
      const code = await runInit({ outputPath: opts.output, force: opts.force, yes: opts.yes }, io);
      process.exitCode = code;
    });

  program
    .command('demo')
    .description(
      'Run the documented docker compose + demo agent quickstart, verifying health between steps.',
    )
    .action(async () => {
      process.exitCode = await runDemo(io);
    });

  return program;
}
