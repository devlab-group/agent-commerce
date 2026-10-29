/**
 * `agent-commerce reconcile` resolves uncertain payment attempts using chain
 * evidence from their providers.
 *
 * It builds providers as `start` does and initializes the receipt database
 * without starting a listener. Dry runs skip resolution writes. Reconciliation
 * does not settle, broadcast, refund or retry delivery. Exit 0 means the run
 * completed, even with unresolved attempts; 1 means it failed to complete.
 */
import { userInfo } from 'node:os';
import { type Logger, NOOP_LOGGER, systemClock } from '../../core';
import { redactedErrorText } from '../../core/errors';
import type { ReconcileReport } from '../../core/execution/reconcile';
import { type ConfigLoader, loadConfigDynamic } from '../lib/config-client';
import type { Io } from '../lib/io';
import { formatConfigError } from './validate';

export interface ReconcileOptions {
  readonly configPath?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly actor?: string;
  readonly minAge?: string;
  readonly limit?: string;
}

export interface ReconcileDeps {
  readonly loadConfig?: ConfigLoader;
}

const DURATION = /^(\d{1,9})(s|m|h|d)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export async function runReconcileCommand(
  options: ReconcileOptions,
  io: Io,
  deps: ReconcileDeps = {},
): Promise<number> {
  const minAgeMs = options.minAge !== undefined ? parseDuration(options.minAge) : undefined;
  if (minAgeMs === null) {
    io.stderr(`FAIL  --min-age must be a duration such as 30s, 15m or 2h, got "${options.minAge}"`);
    return 1;
  }
  const limit = options.limit !== undefined ? Number(options.limit) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    io.stderr(`FAIL  --limit must be a positive integer, got "${options.limit}"`);
    return 1;
  }
  const actor = options.actor ?? osUser();
  if (actor.trim() === '') {
    io.stderr('FAIL  --actor must not be empty');
    return 1;
  }

  let config: Awaited<ReturnType<ConfigLoader>>;
  try {
    config = await (deps.loadConfig ?? loadConfigDynamic)(
      options.configPath !== undefined ? { path: options.configPath } : {},
    );
  } catch (error) {
    io.stderr(formatConfigError(error, false, false));
    return 1;
  }

  try {
    // Load providers and their optional peers on demand, as start does
    const [{ createConfiguredPaymentProviders }, { createSqliteReceiptStore }, { runReconcile }] =
      await Promise.all([
        import('../../gateway/payment-providers'),
        import('../../storage/receipts'),
        import('../../core/execution/reconcile'),
      ]);
    const logger = stderrLogger(io);
    const providers = await createConfiguredPaymentProviders(config.payments, logger);
    const store = createSqliteReceiptStore({ path: config.storage.receipts.path, logger });
    await store.init();
    try {
      const report = await runReconcile({
        store,
        providers,
        clock: systemClock,
        actor,
        dryRun: options.dryRun === true,
        ...(minAgeMs !== undefined ? { minAgeMs } : {}),
        ...(limit !== undefined ? { limit } : {}),
        logger,
      });
      printReport(report, io, options.json === true);
    } finally {
      await store.close();
    }
    return 0;
  } catch (error) {
    io.stderr(`FAIL  reconcile could not run: ${redactedErrorText(error)}`);
    return 1;
  }
}

/** Converts `0` or whole-number s, m, h or d durations to milliseconds, or null if invalid */
export function parseDuration(value: string): number | null {
  if (value === '0') return 0;
  const match = DURATION.exec(value);
  return match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : null;
}

function printReport(report: ReconcileReport, io: Io, json: boolean): void {
  const count = (outcome: string) => report.entries.filter((e) => e.outcome === outcome).length;
  const counts = {
    candidates: report.entries.length,
    settled: count('settled'),
    notSettled: count('not-settled'),
    unknown: count('unknown'),
    resolved: report.entries.filter((e) => e.written).length,
  };
  if (json) {
    io.stdout(JSON.stringify({ dryRun: report.dryRun, counts, entries: report.entries }, null, 2));
    return;
  }
  io.stdout(
    `reconcile${report.dryRun ? ' (dry run, no resolutions written)' : ''}: ${counts.candidates} candidates, ` +
      `${counts.settled} settled, ${counts.notSettled} not settled, ${counts.unknown} unknown, ` +
      `${counts.resolved} resolved`,
  );
  for (const entry of report.entries) {
    io.stdout(
      [
        entry.outcome.toUpperCase().padEnd(11),
        entry.attemptId,
        `request=${entry.requestId}`,
        `provider=${entry.provider}`,
        `status=${entry.status}`,
        `reason=${entry.reason}`,
        ...(entry.externalReference !== undefined ? [`reference=${entry.externalReference}`] : []),
        ...(entry.retryAfter !== undefined ? [`retryAfter=${entry.retryAfter}`] : []),
        ...(entry.written ? ['resolved'] : []),
      ].join(' '),
    );
  }
}

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

// Warnings and errors go to stderr, so --json output stays parseable
function stderrLogger(io: Io): Logger {
  const write = (level: string) => (obj: Record<string, unknown>, msg?: string) =>
    io.stderr(`${level}  ${msg ?? ''} ${JSON.stringify(obj)}`.trimEnd());
  return {
    ...NOOP_LOGGER,
    warn: write('WARN'),
    error: write('ERROR'),
    child: () => stderrLogger(io),
  };
}
