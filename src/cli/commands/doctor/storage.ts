// Storage checks: the receipt store, and the SQLite files other features keep
import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import type { ReceiptStore } from '../../../core';
import type { GatewayConfig } from '../../lib/config-client';
import type { CheckStatus, DoctorCheck } from './types';

// Whether an existing file is writable, without creating one
function isWritableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// A SQLite store file, diagnosed without creating it (see the Storage check in
// `runDoctor`). `suffix` is appended to every detail.
export function storeFileCheck(
  name: string,
  path: string,
  risk: { readonly inMemory: string; readonly unwritable: string },
  suffix = '',
): DoctorCheck {
  if (path === ':memory:') {
    return {
      name,
      status: 'WARN',
      detail: `in-memory store: ${risk.inMemory}; use a file path in production${suffix}`,
    };
  }
  if (existsSync(path)) {
    return isWritableFile(path)
      ? { name, status: 'PASS', detail: `writable at "${path}"${suffix}` }
      : {
          name,
          status: 'FAIL',
          detail: `"${path}" exists but is not writable by this user, so ${risk.unwritable}${suffix}`,
        };
  }
  return { name, status: 'WARN', detail: `${missingStoreDetail(path)}${suffix}` };
}

// Every SQLite store opens through `openSqliteDatabase`, which creates the file
// and a missing directory, so one wording covers them all
function missingStoreDetail(path: string): string {
  const directory = dirname(path);
  return directory !== '.' && !existsSync(directory)
    ? `no store at "${path}" and its directory does not exist. Both are created when the gateway starts, provided the path is writable`
    : `no store at "${path}" yet. It is created the first time the gateway starts`;
}

export async function storageChecks(
  config: GatewayConfig | undefined,
  createStore: (path: string) => ReceiptStore,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  // 7. Storage
  if (config === undefined) {
    checks.push({ name: 'Storage', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (
    // Diagnose without creating: createSqliteReceiptStore creates the file,
    // so opening a wrong path (a typo, or a container path read from the
    // host) would leave an empty database and report it healthy, hiding the
    // real one. `:memory:` never exists on disk, so it takes the open branch
    // below.
    config.storage.receipts.path !== ':memory:' &&
    !existsSync(config.storage.receipts.path)
  ) {
    checks.push({
      name: 'Storage',
      status: 'WARN',
      detail:
        `${missingStoreDetail(config.storage.receipts.path)}. If the gateway is ` +
        'already running, this path does not match the one it uses.',
    });
  } else {
    let store: ReceiptStore | undefined;
    try {
      store = createStore(config.storage.receipts.path);
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
      const status: CheckStatus =
        storeHealth.status === 'pass' ? 'PASS' : storeHealth.status === 'warn' ? 'WARN' : 'FAIL';
      const receiptsSuffix =
        receiptCount !== undefined
          ? `; receipts=${receiptCount}${undeliveredCount !== undefined && undeliveredCount > 0 ? ` (${undeliveredCount} undelivered)` : ''}`
          : '';
      checks.push({
        name: 'Storage',
        status,
        detail: `${storeHealth.detail ?? 'sqlite'}${receiptsSuffix}`,
      });
    } catch (err) {
      checks.push({
        name: 'Storage',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await store?.close();
    }
  }
  return checks;
}
