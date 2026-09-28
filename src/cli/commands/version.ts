import type { Io } from '../lib/io';
import { readVersionReport, type VersionReport } from '../lib/versions';

export interface VersionDeps {
  readonly readVersionReport?: () => VersionReport;
}

/** `agent-commerce version`: the CLI version and the pinned protocol/SDK versions */
export function runVersion(io: Io, deps: VersionDeps = {}): number {
  const report = (deps.readVersionReport ?? readVersionReport)();
  io.stdout(`agent-commerce v${report.cliVersion}`);
  if (report.pinned.length > 0) {
    io.stdout('');
    io.stdout('Pinned protocol / SDK versions:');
    const width = Math.max(...report.pinned.map((pin) => pin.name.length));
    for (const pin of report.pinned) {
      io.stdout(`  ${pin.name.padEnd(width)}  ${pin.version.padEnd(12)} (via ${pin.via})`);
    }
  }
  return 0;
}
