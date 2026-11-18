// `agent-commerce export mcp-registry`: write `server.json` for the MCP Registry from config
import { existsSync } from 'node:fs';
import { type ConfigLoader, type GatewayConfig, loadConfigDynamic } from '../lib/config-client';
import type { Io } from '../lib/io';
import { serverJson } from '../lib/mcp-registry';
import { writeAtomically } from '../lib/write-file';
import { formatConfigError } from './validate';

export interface ExportMcpRegistryOptions {
  readonly configPath?: string;
  readonly output: string;
  readonly force?: boolean;
}

export interface ExportMcpRegistryDeps {
  readonly loadConfig?: ConfigLoader;
}

/** Exports a listing after config loading and listing checks succeed */
export async function runExportMcpRegistry(
  options: ExportMcpRegistryOptions,
  io: Io,
  deps: ExportMcpRegistryDeps = {},
): Promise<number> {
  const { output } = options;
  if (existsSync(output) && options.force !== true) {
    io.stderr(`FAIL  ${output} already exists. Re-run with --force to overwrite.`);
    return 1;
  }

  let config: GatewayConfig;
  try {
    config = await (deps.loadConfig ?? loadConfigDynamic)(
      options.configPath !== undefined ? { path: options.configPath } : {},
    );
  } catch (error) {
    io.stderr(formatConfigError(error, false, false));
    return 1;
  }

  const result = serverJson(config);
  if ('problems' in result) {
    for (const problem of result.problems) io.stderr(`FAIL  ${problem.key} ${problem.message}`);
    return 1;
  }

  try {
    await writeAtomically(output, `${JSON.stringify(result.document, null, 2)}\n`);
  } catch (error) {
    io.stderr(
      `FAIL  ${output} could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  io.stdout(`Wrote ${output} for ${result.document.name} ${result.document.version}.`);
  io.stdout('Publish it with mcp-publisher after verifying the namespace.');
  return 0;
}
