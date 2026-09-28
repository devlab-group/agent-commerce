import { Command } from 'commander';
import { DEFAULT_CONFIG_FILENAME } from '../config/filename';
import { PROTOCOL_NAMES } from '../core';
import { runDemo } from './commands/demo';
import { printDoctorReport, runDoctor } from './commands/doctor';
import { runImportOpenApi } from './commands/import-openapi';
import { runInit } from './commands/init';
import { runValidate } from './commands/validate';
import { runVersion } from './commands/version';
import { type Io, processIo } from './lib/io';
import { readVersionReport } from './lib/versions';

/**
 * Builds the `agent-commerce` Commander program.
 *
 * `io` is injectable so tests can capture output. With `exitOverride()` and
 * `configureOutput()`, `--help` and parse errors never call `process.exit()`,
 * so the caller (index.ts or a test) controls the process lifecycle.
 */
export function buildProgram(io: Io = processIo): Command {
  const program = new Command();

  program
    .name('agent-commerce')
    .description('CLI for the Agent Commerce Gateway: init, import, validate, doctor, demo.')
    // `--version` prints the CLI version only; the `version` subcommand also
    // lists the pinned protocol/SDK versions. Both read `readVersionReport()`,
    // so they cannot disagree.
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

  // A command group, so another importer can be added beside `openapi`
  // without renaming it
  const importCommand = program
    .command('import')
    .description('Generate Agent Commerce resource drafts from an API description.');

  importCommand
    .command('openapi')
    .description('Convert a local OpenAPI 3.0/3.1/3.2 document into resource drafts.')
    .argument('<source>', 'path to a local .yaml, .yml or .json OpenAPI document')
    .option(
      '--output <path>',
      'output path (default: <source name without extension>.agent-commerce.yaml in the current directory)',
    )
    .option('--force', 'overwrite an existing output file', false)
    .option('--base-url <url>', 'backend base URL, overriding the document servers')
    .option(
      '--operation <operationId>',
      'import only this operation (repeatable)',
      collect,
      undefined,
    )
    .option('--tag <tag>', 'import only operations with this tag (repeatable, OR-ed)', collect)
    .option('--free', 'mark generated resources as pricing.type free', false)
    .option('--expose <protocols>', `comma-separated: ${PROTOCOL_NAMES.join(',')}`)
    .option('--strict', 'exit non-zero when the import produced warnings', false)
    .option('--json', 'emit a machine-readable summary instead of a report', false)
    .action(
      async (
        source: string,
        opts: {
          output?: string;
          force: boolean;
          baseUrl?: string;
          operation?: string[];
          tag?: string[];
          free: boolean;
          expose?: string;
          strict: boolean;
          json: boolean;
        },
      ) => {
        process.exitCode = await runImportOpenApi(
          {
            source,
            ...(opts.output !== undefined ? { output: opts.output } : {}),
            force: opts.force,
            ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
            ...(opts.operation !== undefined ? { operations: opts.operation } : {}),
            ...(opts.tag !== undefined ? { tags: opts.tag } : {}),
            free: opts.free,
            ...(opts.expose !== undefined ? { expose: opts.expose } : {}),
            strict: opts.strict,
            json: opts.json,
          },
          io,
        );
      },
    );

  program
    .command('demo')
    .description(
      'Start the local stack with docker compose (waiting for healthy services), then run the demo agent. Run it from a repo clone.',
    )
    .action(async () => {
      process.exitCode = await runDemo(io);
    });

  return program;
}

// Commander's repeatable-option collector
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
