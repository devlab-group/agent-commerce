/**
 * `agent-commerce reconcile` resolves uncertain payment attempts using chain
 * evidence from their providers.
 *
 * It builds providers as `start` does and initializes the receipt database
 * without starting a listener. Enabled AP2 providers update holds on resolved
 * payments without verifying mandates. Dry runs skip resolution and hold
 * writes. Reconciliation does not settle, broadcast, refund or retry delivery.
 * Exit 0 means the run completed, even with unresolved attempts; 1 means it
 * failed to complete.
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import {
  type AuthorizationProvider,
  CommerceError,
  type Logger,
  NOOP_LOGGER,
  type ReceiptStore,
  systemClock,
} from '../../core';
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
    const logger = stderrLogger(io);
    const { runReconcile } = await import('../../core/execution/reconcile');
    const providers = await (
      await import('../../gateway/payment-providers')
    ).createConfiguredPaymentProviders(config.payments, logger);
    await withJournal(config, logger, async (store, authorizationProviders) => {
      const report = await runReconcile({
        store,
        providers,
        authorizationProviders,
        clock: systemClock,
        actor,
        dryRun: options.dryRun === true,
        ...(minAgeMs !== undefined ? { minAgeMs } : {}),
        ...(limit !== undefined ? { limit } : {}),
        logger,
      });
      printReport(report, io, options.json === true);
    });
    return 0;
  } catch (error) {
    io.stderr(`FAIL  reconcile could not run: ${redactedErrorText(error)}`);
    return 1;
  }
}

/**
 * Runs `fn` with the receipt store and enabled authorization providers,
 * closing them afterward. Used by `reconcile` and `resolve` with the gateway
 * running or stopped. It initializes the receipt store but does not import
 * legacy files. With AP2 enabled, an existing file with no recorded import
 * blocks payment and hold updates until `start` imports it.
 */
export async function withJournal(
  config: Awaited<ReturnType<ConfigLoader>>,
  logger: Logger,
  fn: (
    store: ReceiptStore,
    authorizationProviders: readonly AuthorizationProvider[],
  ) => Promise<void>,
): Promise<void> {
  const [{ createConfiguredAuthorizationProviders }, { createSqliteReceiptStore }] =
    await Promise.all([
      import('../../gateway/payment-providers'),
      import('../../storage/receipts'),
    ]);
  const store = createSqliteReceiptStore({ path: config.storage.receipts.path, logger });
  try {
    await store.init();
    const ap2 = config.authorization?.ap2;
    const replayPath = ap2?.enabled ? ap2.replay?.path : undefined;
    if (replayPath !== undefined && replayPath !== ':memory:' && existsSync(replayPath)) {
      const { legacyImports } = await store.summary({ orphanHoldMinAgeMs: 0 });
      if (!legacyImports.some((entry) => entry.source === 'ap2-replay')) {
        // A hold update now would miss the mandates still in that file
        throw new CommerceError(
          'STORAGE_ERROR',
          `the AP2 replay file "${resolve(replayPath)}" has not been imported into the receipt database yet. Run \`agent-commerce start\` once to import it, then retry.`,
        );
      }
    }
    const authorizationProviders = await createConfiguredAuthorizationProviders(
      config.authorization,
      logger,
      store,
    );
    try {
      await fn(store, authorizationProviders);
    } finally {
      for (const provider of authorizationProviders) provider.close();
    }
  } finally {
    await store.close();
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
    holdsAligned: report.holds.filter((h) => h.written).length,
    orphanHolds: report.orphanHolds.length,
    orphanHoldsReleased: report.orphanHolds.filter((h) => h.released).length,
  };
  if (json) {
    io.stdout(
      JSON.stringify(
        {
          dryRun: report.dryRun,
          counts,
          entries: report.entries,
          holds: report.holds,
          orphanHolds: report.orphanHolds,
        },
        null,
        2,
      ),
    );
    return;
  }
  io.stdout(
    `reconcile${report.dryRun ? ' (dry run, no resolutions written)' : ''}: ${counts.candidates} candidates, ` +
      `${counts.settled} settled, ${counts.notSettled} not settled, ${counts.unknown} unknown, ` +
      `${counts.resolved} resolved` +
      (report.holds.length > 0
        ? `, ${counts.holdsAligned} of ${report.holds.length} holds aligned`
        : '') +
      (report.orphanHolds.length > 0
        ? `, ${counts.orphanHoldsReleased} of ${report.orphanHolds.length} orphan holds released`
        : ''),
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
        ...(entry.error !== undefined ? [`error=${entry.error}`] : []),
        ...(entry.written ? ['resolved'] : []),
      ].join(' '),
    );
  }
  for (const hold of report.holds) {
    io.stdout(
      [
        'HOLD'.padEnd(11),
        hold.transactionId,
        `attempt=${hold.attemptId}`,
        `method=${hold.method}`,
        `hold=${hold.hold}`,
        ...(hold.reason !== undefined ? [`reason=${hold.reason}`] : []),
        ...(hold.written ? ['aligned'] : []),
      ].join(' '),
    );
  }
  for (const hold of report.orphanHolds) {
    io.stdout(
      [
        'ORPHAN'.padEnd(11),
        hold.reference,
        `request=${hold.requestId}`,
        `method=${hold.method}`,
        `updated=${hold.updatedAt}`,
        ...(hold.reason !== undefined ? [`reason=${hold.reason}`] : []),
        ...(hold.released ? ['released'] : []),
      ].join(' '),
    );
  }
}

/** Returns the OS user name for the default `--actor`, or `unknown` if unavailable */
export function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** Writes warnings and errors to stderr, so `--json` output stays parseable */
export function stderrLogger(io: Io): Logger {
  const write = (level: string) => (obj: Record<string, unknown>, msg?: string) =>
    io.stderr(`${level}  ${msg ?? ''} ${JSON.stringify(obj)}`.trimEnd());
  return {
    ...NOOP_LOGGER,
    warn: write('WARN'),
    error: write('ERROR'),
    child: () => stderrLogger(io),
  };
}
