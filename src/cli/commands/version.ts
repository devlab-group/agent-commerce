import type { Io } from '../lib/io.js';
import { readVersionReport, type VersionReport } from '../lib/versions.js';

export interface VersionDeps {
  readonly readVersionReport?: () => VersionReport;
}

/** `agent-commerce version` — CLI version + pinned protocol/SDK versions. */
export function runVersion(io: Io, deps: VersionDeps = {}): number {
  const report = (deps.readVersionReport ?? readVersionReport)();
  io.stdout(`agent-commerce v${report.cliVersion}`);
  if (report.pinned.length > 0) {
    io.stdout('');
    io.stdout('Pinned protocol / SDK versions:');
    for (const pin of report.pinned) {
      io.stdout(`  ${pin.name.padEnd(24)} ${pin.version.padEnd(12)} (via ${pin.via})`);
    }
  }
  return 0;
}
