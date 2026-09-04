/**
 * `agent-commerce import openapi <source>`.
 *
 * Generates reviewable resource drafts from a local OpenAPI description. It
 * never touches config.yaml and never invents commerce policy: without
 * `--free` / `--expose` the generated file is deliberately incomplete, so a
 * human has to decide what an operation costs and who can see it before
 * anything can load.
 */
import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { PROTOCOL_NAMES } from '../../core/index.js';
import {
  buildResourceDrafts,
  type ImportPolicy,
  type ImportResult,
  loadOpenApiDocument,
  renderResourcesYaml,
} from '../../openapi/index.js';
import type { Io } from '../lib/io.js';

export interface ImportOpenApiOptions {
  readonly source: string;
  readonly output?: string;
  readonly force?: boolean;
  readonly baseUrl?: string;
  readonly operations?: readonly string[];
  readonly tags?: readonly string[];
  readonly free?: boolean;
  readonly expose?: string;
  readonly strict?: boolean;
  readonly json?: boolean;
}

export interface ImportOpenApiDeps {
  readonly fileExists?: (path: string) => boolean;
  readonly writeFile?: (path: string, content: string) => Promise<void>;
}

/** `<source-basename>.agent-commerce.yaml`, in the working directory. */
export function defaultOutputPath(source: string): string {
  const name = basename(source);
  const stem = name.slice(0, name.length - extname(name).length) || name;
  return `${stem}.agent-commerce.yaml`;
}

export async function runImportOpenApi(
  options: ImportOpenApiOptions,
  io: Io,
  deps: ImportOpenApiDeps = {},
): Promise<number> {
  const fileExists = deps.fileExists ?? existsSync;
  const outputPath = options.output ?? defaultOutputPath(options.source);

  let policy: ImportPolicy;
  try {
    policy = buildPolicy(options);
  } catch (error) {
    io.stderr(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // Before doing any work: an existing file the operator did not ask to
  // replace is a stop, not something to discover after the import ran.
  if (fileExists(outputPath) && options.force !== true) {
    io.stderr(`FAIL  ${outputPath} already exists. Re-run with --force to overwrite.`);
    return 1;
  }

  let result: ImportResult;
  try {
    const loaded = await loadOpenApiDocument(options.source);
    result = buildResourceDrafts(loaded, {
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(Object.keys(policy).length > 0 ? { policy } : {}),
      ...(options.operations !== undefined || options.tags !== undefined
        ? {
            include: {
              ...(options.operations !== undefined ? { operationIds: options.operations } : {}),
              ...(options.tags !== undefined ? { tags: options.tags } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    io.stderr(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const skipped = result.diagnostics.filter((entry) => entry.severity === 'error');
  const warnings = result.diagnostics.filter((entry) => entry.severity === 'warning');

  const failures: string[] = [];
  if (result.unmatchedOperationIds.length > 0) {
    failures.push(`no operation matched ${result.unmatchedOperationIds.join(', ')}`);
  }
  if (result.drafts.length === 0) {
    failures.push('no supported operations were imported');
  }
  if (options.strict === true && warnings.length > 0) {
    failures.push(`${warnings.length} warning(s) with --strict`);
  }

  // Nothing is written when the run failed: a half-useful file that the next
  // command silently picks up is worse than no file.
  const wrote = failures.length === 0;
  if (wrote) {
    try {
      await writeAtomically(outputPath, renderResourcesYaml(result), deps);
    } catch (error) {
      io.stderr(`FAIL  ${outputPath} could not be written: ${describe(error)}`);
      return 1;
    }
  }

  if (options.json === true) {
    io.stdout(
      JSON.stringify(
        {
          source: options.source,
          openapi: result.version,
          output: wrote ? outputPath : null,
          imported: result.drafts.length,
          skipped: skipped.length,
          warnings: warnings.length,
          resources: result.drafts.map((draft) => ({
            id: draft.id,
            source: draft.source,
            ...(draft.operationId !== undefined ? { operationId: draft.operationId } : {}),
            tags: draft.tags,
          })),
          diagnostics: result.diagnostics,
          unmatchedOperationIds: result.unmatchedOperationIds,
          exitCode: failures.length === 0 ? 0 : 1,
        },
        null,
        2,
      ),
    );
  } else {
    printSummary(result, { outputPath, wrote, policy }, io);
  }

  for (const failure of failures) io.stderr(`FAIL  ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

function buildPolicy(options: ImportOpenApiOptions): ImportPolicy {
  const policy: { pricing?: Record<string, unknown>; expose?: readonly string[] } = {};
  if (options.free === true) policy.pricing = { type: 'free' };
  if (options.expose !== undefined) {
    const requested = options.expose
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    if (requested.length === 0) {
      throw new Error(`--expose needs at least one protocol (${PROTOCOL_NAMES.join(', ')})`);
    }
    for (const name of requested) {
      if (!PROTOCOL_NAMES.includes(name as (typeof PROTOCOL_NAMES)[number])) {
        throw new Error(
          `--expose "${name}" is not a supported protocol. Supported: ${PROTOCOL_NAMES.join(', ')}`,
        );
      }
    }
    policy.expose = requested;
  }
  return policy;
}

async function writeAtomically(
  outputPath: string,
  content: string,
  deps: ImportOpenApiDeps,
): Promise<void> {
  if (deps.writeFile !== undefined) {
    await deps.writeFile(outputPath, content);
    return;
  }
  // Temp sibling then rename: a crash or a full disk must not leave a
  // half-written file where a complete one used to be.
  const target = resolve(outputPath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function printSummary(
  result: ImportResult,
  context: { outputPath: string; wrote: boolean; policy: ImportPolicy },
  io: Io,
): void {
  const skipped = result.diagnostics.filter((entry) => entry.severity === 'error');
  const warnings = result.diagnostics.filter((entry) => entry.severity === 'warning');

  io.stdout(`OpenAPI ${result.version}: ${result.sourcePath}`);
  io.stdout('');
  io.stdout(`Imported: ${result.drafts.length}`);
  io.stdout(`Skipped:  ${skipped.length}`);
  io.stdout(`Warnings: ${warnings.length}`);

  if (skipped.length > 0) {
    io.stdout('');
    io.stdout('Skipped operations:');
    for (const entry of skipped) io.stdout(`  ${entry.message}`);
  }
  if (warnings.length > 0) {
    io.stdout('');
    io.stdout('Warnings:');
    for (const entry of warnings) io.stdout(`  ${entry.message}`);
  }

  if (context.wrote) {
    io.stdout('');
    io.stdout('Generated:');
    io.stdout(`  ${context.outputPath}`);
  }

  io.stdout('');
  if (context.policy.pricing === undefined || context.policy.expose === undefined) {
    io.stdout('Pricing/exposure were not inferred.');
  }
  io.stdout('Review the generated resources before merging them into config.yaml.');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
