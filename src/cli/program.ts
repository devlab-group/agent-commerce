import { Command } from 'commander';
import { DEFAULT_CONFIG_FILENAME } from '../config/filename';
import { PROTOCOL_NAMES } from '../core';
import { runDemo } from './commands/demo';
import { printDoctorReport, runDoctor } from './commands/doctor';
import { runImportOpenApi } from './commands/import-openapi';
import { runInit } from './commands/init';
import { runReconcileCommand } from './commands/reconcile';
import { runResolveCommand } from './commands/resolve';
import { formatConfigError, runValidate } from './commands/validate';
import { runVersion } from './commands/version';
import { type Io, processIo } from './lib/io';
import { readVersionReport } from './lib/versions';

const ENV_FILE_HELP = 'load environment variables from this file; variables already set win';

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
    .description(
      'CLI for the Agent Commerce Gateway: init, import, validate, start, doctor, reconcile, demo.',
    )
    // `--version` prints the CLI version only; the `version` subcommand also
    // lists the pinned protocol/SDK versions. Both read `readVersionReport()`,
    // so they cannot disagree.
    .version(readVersionReport().cliVersion, '-v, --version', 'Print the CLI version.')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout(str.replace(/\n+$/, '')),
      writeErr: (str) => io.stderr(str.replace(/\n+$/, '')),
    })
    // Load before the action reads config; existing environment variables win.
    // Node 24.8.0 checks --env-file paths anywhere on the command line but does
    // not load files named after the script, so this hook handles those paths.
    .hook('preAction', (_program, command) => {
      const { envFile } = command.opts<{ envFile?: string }>();
      if (envFile === undefined) return;
      try {
        process.loadEnvFile(envFile);
      } catch (error) {
        command.error(
          `error: cannot read --env-file "${envFile}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
    .option('--env-file <path>', ENV_FILE_HELP)
    .action(async (opts: { config?: string }) => {
      const code = await runValidate(
        opts.config !== undefined ? { configPath: opts.config } : {},
        io,
      );
      process.exitCode = code;
    });

  program
    .command('start')
    .description(
      `Start the gateway from ${DEFAULT_CONFIG_FILENAME} and serve until SIGTERM or SIGINT.`,
    )
    .option('--config <path>', `path to ${DEFAULT_CONFIG_FILENAME}`)
    .option('--env-file <path>', ENV_FILE_HELP)
    .action(async (opts: { config?: string }) => {
      try {
        // Loaded on demand: the gateway brings fastify, and each enabled
        // feature its optional peers, which no other command may need
        const { runGateway } = await import('../gateway/run');
        await runGateway(opts.config !== undefined ? { configPath: opts.config } : {});
      } catch (error) {
        // The same report as validate. start never reads the local chain
        // manifest, so the hint for an unset variable must not suggest it.
        io.stderr(formatConfigError(error, false, false));
        // Do not wait on anything a failed startup left open
        process.exit(1);
      }
    });

  program
    .command('doctor')
    .description('Diagnose config, gateway, backend, protocol and payment health.')
    .option('--config <path>', `path to ${DEFAULT_CONFIG_FILENAME}`)
    .option('--env-file <path>', ENV_FILE_HELP)
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
    .command('reconcile')
    .description(
      'Resolve uncertain payment attempts using chain evidence. Never settles or refunds.',
    )
    .option('--config <path>', `path to ${DEFAULT_CONFIG_FILENAME}`)
    .option('--env-file <path>', ENV_FILE_HELP)
    .option('--dry-run', 'read evidence and report without recording resolutions', false)
    .option('--json', 'emit machine-readable JSON instead of a formatted report', false)
    .option('--actor <name>', 'who ran it, stored with each resolution (default: the OS user)')
    .option(
      '--min-age <duration>',
      'skip reserved attempts younger than this, such as 30s, 15m or 2h (default: 15m)',
    )
    .option('--limit <n>', 'check at most this many attempts, and update at most this many holds')
    .action(
      async (opts: {
        config?: string;
        dryRun: boolean;
        json: boolean;
        actor?: string;
        minAge?: string;
        limit?: string;
      }) => {
        process.exitCode = await runReconcileCommand(
          {
            ...(opts.config !== undefined ? { configPath: opts.config } : {}),
            dryRun: opts.dryRun,
            json: opts.json,
            ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
            ...(opts.minAge !== undefined ? { minAge: opts.minAge } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          },
          io,
        );
      },
    );

  program
    .command('resolve <attemptId>')
    .description(
      'Record a verdict on one unresolved payment attempt and align its hold. Never settles or refunds.',
    )
    .requiredOption('--status <status>', 'settled or rejected')
    .requiredOption('--reason <text>', 'why, stored with the resolution')
    .option('--reference <ref>', 'transaction reference, stored as your unchecked claim')
    .option('--actor <name>', 'who resolved it, stored with the resolution (default: the OS user)')
    .option(
      '--confirm-expired',
      'confirm that an authorization with no recorded expiry can no longer land',
      false,
    )
    .option('--config <path>', `path to ${DEFAULT_CONFIG_FILENAME}`)
    .option('--env-file <path>', ENV_FILE_HELP)
    .action(
      async (
        attemptId: string,
        opts: {
          config?: string;
          status: string;
          reason: string;
          reference?: string;
          actor?: string;
          confirmExpired: boolean;
        },
      ) => {
        process.exitCode = await runResolveCommand(
          attemptId,
          {
            ...(opts.config !== undefined ? { configPath: opts.config } : {}),
            status: opts.status,
            reason: opts.reason,
            ...(opts.reference !== undefined ? { reference: opts.reference } : {}),
            ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
            confirmExpired: opts.confirmExpired,
          },
          io,
        );
      },
    );

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
