// Prints a doctor report as text or JSON
import picocolors from 'picocolors';
import type { Io } from '../../lib/io';
import type { CheckStatus, DoctorReport } from './types';

function statusColor(status: CheckStatus, text: string): string {
  switch (status) {
    case 'PASS':
      return picocolors.green(text);
    case 'WARN':
      return picocolors.yellow(text);
    case 'FAIL':
      return picocolors.red(text);
    case 'INFO':
      return picocolors.cyan(text);
  }
}

export function printDoctorReport(report: DoctorReport, io: Io, json: boolean): void {
  if (json) {
    io.stdout(JSON.stringify(report, null, 2));
    return;
  }
  for (const check of report.checks) {
    const label = statusColor(check.status, check.status.padEnd(5));
    io.stdout(`${label} ${check.name.padEnd(20)} ${check.detail}`);
  }
  io.stdout('');
  io.stdout(`Score: ${report.score.passed}/${report.score.total} checks passed`);
}
