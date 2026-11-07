// Storage checks: the receipt store, its journal, and the deprecated store files
import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isCommerceError } from '../../../core';
import { DEFAULT_RECONCILE_MIN_AGE_MS } from '../../../core/execution/reconcile';
import {
  type LegacySource,
  readMissingLegacyImports,
  type SqliteLegacyImport,
  type SqliteReceiptStoreSummary,
} from '../../../storage/receipts';
import type { GatewayConfig } from '../../lib/config-client';
import type { CheckStatus, DoctorCheck, DoctorStore } from './types';

// Whether an existing file is writable, without creating one
function isWritableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recorded file imports and sources with missing legacy history. Both lists
 * are empty for a missing database. Undefined means the information is
 * unavailable, including when the store has no summary or the read fails.
 */
export type LegacyState =
  | {
      readonly imports: readonly SqliteLegacyImport[];
      readonly missing: readonly LegacySource[];
    }
  | undefined;

const LEGACY_KEYS: Record<LegacySource, { readonly feature: string; readonly key: string }> = {
  'ap2-replay': { feature: 'AP2', key: 'authorization.ap2.replay.path' },
  'acp-idempotency': { feature: 'ACP', key: 'protocols.acp.idempotency.path' },
};

/**
 * Checks an enabled feature's legacy setting against startup import rules.
 * `path` is undefined for an unset key. `pass` supplies the detail for a PASS
 * result; `note` is appended to every other result's detail.
 */
export function legacyStoreCheck(
  name: string,
  source: LegacySource,
  path: string | undefined,
  legacy: LegacyState,
  pass: string,
  note = '',
): DoctorCheck {
  const marker = legacy?.imports.find((entry) => entry.source === source);
  if (marker !== undefined) {
    if (path === undefined) return { name, status: 'PASS', detail: pass };
    return path !== ':memory:' && resolve(path) !== marker.path
      ? {
          name,
          status: 'FAIL',
          detail: `deprecated key names "${path}", but "${marker.path}" was imported already, so start refuses it. Point the key back at the imported file, or remove the key${note}`,
        }
      : {
          name,
          status: 'WARN',
          detail: `deprecated key: ${marker.rows} row(s) moved into the receipt database at ${marker.importedAt}; remove the key${note}`,
        };
  }
  // A source in `missing` makes start refuse an unset key or a missing file
  const forgotten = legacy?.missing.includes(source) === true;
  if (path === ':memory:') {
    return {
      name,
      status: 'WARN',
      detail: forgotten
        ? `deprecated key: an in-memory store has nothing to import. Start the gateway once with this key set, then remove it${note}`
        : `deprecated key: an in-memory store has nothing to import; remove the key${note}`,
    };
  }
  if (path === undefined || !existsSync(path)) {
    if (forgotten) {
      const { feature, key } = LEGACY_KEYS[source];
      return {
        name,
        status: 'FAIL',
        detail: `${feature} ran on this receipt database before and its records were never imported, so start refuses ${path === undefined ? 'the unset key' : `"${path}", which does not exist`}. Set ${key} to the file the previous version used, or to an empty file to accept the loss${note}`,
      };
    }
    return path === undefined
      ? { name, status: 'PASS', detail: pass }
      : {
          name,
          status: 'WARN',
          detail: `deprecated key: no file at "${path}", so there is nothing to import; remove the key${note}`,
        };
  }
  if (!isWritableFile(path)) {
    return {
      name,
      status: 'FAIL',
      detail: `"${path}" exists but is not writable by this user, so the first start cannot lock the file to import it${note}`,
    };
  }
  return {
    name,
    status: 'WARN',
    detail:
      legacy === undefined
        ? `deprecated key: start imports "${path}" into the receipt database once; the receipt database could not be read to tell whether it has${note}`
        : `deprecated key: rows in "${path}" are not moved yet. Start the gateway once with this key set, then remove it${note}`,
  };
}

// Gateway startup creates a missing receipt file and parent directories
function missingStoreDetail(path: string): string {
  const directory = dirname(path);
  return directory !== '.' && !existsSync(directory)
    ? `no store at "${path}" and its directory does not exist. Both are created when the gateway starts, provided the path is writable`
    : `no store at "${path}" yet. It is created the first time the gateway starts`;
}

// Extract schema versions from a diagnostic open failure
function refusedSchema(err: unknown): { schemaVersion: number; expected: number } | undefined {
  if (!isCommerceError(err)) return undefined;
  const { schemaVersion, expected } = err.details ?? {};
  return typeof schemaVersion === 'number' && typeof expected === 'number'
    ? { schemaVersion, expected }
    : undefined;
}

export interface StorageReport {
  readonly checks: DoctorCheck[];
  readonly legacy: LegacyState;
}

export async function storageChecks(
  config: GatewayConfig | undefined,
  openStore: (path: string) => DoctorStore,
): Promise<StorageReport> {
  // 7. Storage
  if (config === undefined) {
    return {
      checks: [{ name: 'Storage', status: 'WARN', detail: 'skipped: config invalid' }],
      legacy: undefined,
    };
  }
  const path = config.storage.receipts.path;
  // Report a missing file before opening it, exposing path typos and
  // host/container path mismatches. `:memory:` has no file to check and
  // takes the open branch below.
  if (path !== ':memory:' && !existsSync(path)) {
    return {
      checks: [
        {
          name: 'Storage',
          status: 'WARN',
          detail: `${missingStoreDetail(path)}. If the gateway is already running, this path does not match the one it uses.`,
        },
      ],
      legacy: { imports: [], missing: [] },
    };
  }

  const checks: DoctorCheck[] = [];
  let summary: SqliteReceiptStoreSummary | undefined;
  let store: DoctorStore | undefined;
  try {
    store = openStore(path);
    await store.init();
    const storeHealth = await store.health();
    let receiptCount: number | undefined;
    try {
      // Exact count, not a list length: listReceipts clamps every page
      receiptCount = await store.countReceipts();
    } catch {
      receiptCount = undefined;
    }
    let undeliveredCount: number | undefined;
    try {
      // Paid but undelivered purchases (see
      // `ReceiptStore.countUndeliveredReceipts`), the rows the dashboard
      // flags as "Charged but not delivered"
      undeliveredCount = await store.countUndeliveredReceipts();
    } catch {
      undeliveredCount = undefined;
    }
    let uncertainCount: number | undefined;
    try {
      // Count uncertain settlements separately because they produce no receipt
      uncertainCount = await store.countUncertainPaymentAttempts();
    } catch {
      uncertainCount = undefined;
    }
    try {
      summary = await store.summary?.({ orphanHoldMinAgeMs: DEFAULT_RECONCILE_MIN_AGE_MS });
    } catch {
      summary = undefined;
    }
    const status: CheckStatus =
      storeHealth.status === 'pass' ? 'PASS' : storeHealth.status === 'warn' ? 'WARN' : 'FAIL';
    const receiptsSuffix =
      receiptCount !== undefined
        ? `; receipts=${receiptCount}${undeliveredCount !== undefined && undeliveredCount > 0 ? ` (${undeliveredCount} undelivered)` : ''}`
        : '';
    const uncertainSuffix =
      uncertainCount !== undefined && uncertainCount > 0
        ? `; ${uncertainCount} payment(s) with unknown settlement outcome, see GET /api/transactions?unresolved=true or run agent-commerce reconcile`
        : '';
    checks.push({
      name: 'Storage',
      status,
      detail: `${storeHealth.detail ?? 'sqlite'}${receiptsSuffix}${uncertainSuffix}`,
    });
  } catch (err) {
    const refused = refusedSchema(err);
    if (refused !== undefined && refused.schemaVersion < refused.expected) {
      // Imports begin at schema v5, so an older schema has none recorded
      const missing = readMissingLegacyImports(path);
      return {
        checks: [
          {
            name: 'Storage',
            status: 'WARN',
            detail: `sqlite schema v${refused.schemaVersion}; the next start migrates it to v${refused.expected}, which earlier versions cannot open. Run agent-commerce backup first to keep a copy they can`,
          },
        ],
        legacy: missing !== undefined ? { imports: [], missing } : undefined,
      };
    }
    checks.push({
      name: 'Storage',
      status: 'FAIL',
      detail:
        refused !== undefined
          ? `sqlite schema v${refused.schemaVersion} is newer than this version reads (v${refused.expected}); run the version that wrote it`
          : err instanceof Error
            ? err.message
            : String(err),
    });
  } finally {
    await store?.close();
  }

  if (summary !== undefined) checks.push(...summaryChecks(summary));
  return {
    checks,
    legacy:
      summary !== undefined
        ? { imports: summary.legacyImports, missing: summary.missingLegacyImports }
        : undefined,
  };
}

function summaryChecks(summary: SqliteReceiptStoreSummary): DoctorCheck[] {
  const states = Object.entries(summary.unresolvedTransactions);
  const checks: DoctorCheck[] = [
    states.length > 0
      ? {
          name: 'Transactions',
          status: 'WARN',
          detail: `unresolved: ${states.map(([state, count]) => `${state}=${count}`).join(', ')}; see GET /api/transactions?unresolved=true or run agent-commerce reconcile`,
        }
      : { name: 'Transactions', status: 'PASS', detail: 'none unresolved' },
  ];
  if (summary.orphanHolds > 0) {
    checks.push({
      name: 'Authorization holds',
      status: 'WARN',
      detail: `${summary.orphanHolds} reserved hold(s) older than ${DEFAULT_RECONCILE_MIN_AGE_MS / 60_000} min have no payment attempt and keep their mandates blocked; agent-commerce reconcile releases them while their authorization method is enabled`,
    });
  }
  if (summary.unresolvedIdempotencyKeys > 0) {
    checks.push({
      name: 'ACP claims',
      status: 'INFO',
      detail: `${summary.unresolvedIdempotencyKeys} unresolved; a retry with the same Idempotency-Key gets 409 idempotency_unresolved`,
    });
  }
  if (summary.unresolvedPaymentKeys > 0) {
    checks.push({
      name: 'Payment retry keys',
      status: 'INFO',
      detail: `${summary.unresolvedPaymentKeys} unresolved; a paid retry with the same key gets 409 payment_identifier_unresolved`,
    });
  }
  return checks;
}
