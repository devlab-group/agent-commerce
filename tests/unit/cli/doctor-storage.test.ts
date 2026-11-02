// Doctor's journal, legacy-store diagnostics and read-only database access
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../../src/cli/commands/doctor';
import { legacyStoreCheck } from '../../../src/cli/commands/doctor/storage';
import type { DoctorStore } from '../../../src/cli/commands/doctor/types';
import type { GatewayConfig } from '../../../src/config';
import {
  createSqliteReceiptStore,
  type SqliteLegacyImport,
  type SqliteReceiptStoreSummary,
} from '../../../src/storage/receipts';
import { createFakeFetch, jsonResponse, makeFakeReceiptStore, makeGatewayConfig } from './fixtures';

const GATEWAY = 'http://127.0.0.1:8080';
const FIXTURE_V4 = readFileSync(
  new URL('../storage-receipts/fixtures/receipts-v4.sql', import.meta.url),
  'utf8',
);
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

const healthyFetch = () =>
  createFakeFetch({
    [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
    [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
    [`${GATEWAY}/.well-known/agent-commerce`]: () =>
      jsonResponse({ merchant: { id: 'demo-merchant' } }),
  });

const EMPTY_SUMMARY: SqliteReceiptStoreSummary = {
  unresolvedTransactions: {},
  orphanHolds: 0,
  unresolvedIdempotencyKeys: 0,
  unexpiredPendingTasks: 0,
  legacyImports: [],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oac-doctor-storage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Enable ACP with an optional legacy path for testing 2.5 configurations
function acpConfig(receipts: string, idempotencyPath?: string): GatewayConfig {
  const base = makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path: receipts } } });
  return {
    ...base,
    protocols: {
      ...base.protocols,
      acp: {
        enabled: true,
        mountPath: '/acp',
        auth: { type: 'bearer', token: 'acp-token' },
        idempotency: {
          ...(idempotencyPath !== undefined ? { path: idempotencyPath } : {}),
          retentionHours: 24,
        },
        checkout: {
          operations: {
            createCheckoutSession: 'acp_create',
            updateCheckoutSession: 'acp_update',
            getCheckoutSession: 'acp_get',
            completeCheckoutSession: 'acp_complete',
            cancelCheckoutSession: 'acp_cancel',
          },
        },
      } as GatewayConfig['protocols']['acp'],
    },
  };
}

function doctorWith(config: GatewayConfig, createStore?: (path: string) => DoctorStore) {
  return runDoctor(
    { gatewayUrl: GATEWAY },
    {
      fetchImpl: healthyFetch(),
      loadConfig: async () => config,
      ...(createStore !== undefined ? { createStore } : {}),
    },
  );
}

const check = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((c) => c.name === name);

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function readDb<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe('legacyStoreCheck', () => {
  const imported: SqliteLegacyImport = {
    source: 'ap2-replay',
    path: '/data/ap2.sqlite',
    rows: 3,
    importedAt: '2026-11-01T10:00:00.000Z',
  };

  it('warns to remove a key whose file was imported, naming the rows and the time', () => {
    expect(
      legacyStoreCheck('AP2 replay store', 'ap2-replay', '/data/ap2.sqlite', [imported]),
    ).toEqual({
      name: 'AP2 replay store',
      status: 'WARN',
      detail:
        'deprecated key: 3 row(s) moved into the receipt database at 2026-11-01T10:00:00.000Z; remove the key',
    });
  });

  it('compares a relative key with the absolute path the import recorded', () => {
    const file = join(dir, 'ap2.sqlite');
    const check = legacyStoreCheck(
      'AP2 replay store',
      'ap2-replay',
      relative(process.cwd(), file),
      [{ ...imported, path: file }],
    );
    expect(check.status).toBe('WARN');
  });

  it('fails a key that names another file than the one imported, as start refuses it', () => {
    expect(
      legacyStoreCheck('AP2 replay store', 'ap2-replay', '/data/other.sqlite', [imported]),
    ).toEqual({
      name: 'AP2 replay store',
      status: 'FAIL',
      detail:
        'deprecated key names "/data/other.sqlite", but "/data/ap2.sqlite" was imported already, so start refuses it. Point the key back at the imported file, or remove the key',
    });
  });

  it("ignores another source's import", () => {
    const file = join(dir, 'acp.sqlite');
    writeFileSync(file, '');
    const check = legacyStoreCheck('ACP idempotency', 'acp-idempotency', file, [imported]);
    expect(check.detail).toBe(
      `deprecated key: rows in "${file}" are not moved yet. Start the gateway once with this key set, then remove it`,
    );
  });

  it('warns that an existing file is not moved yet when the database records no import', () => {
    const file = join(dir, 'ap2.sqlite');
    writeFileSync(file, '');
    expect(legacyStoreCheck('AP2 replay store', 'ap2-replay', file, [], ' (note)')).toEqual({
      name: 'AP2 replay store',
      status: 'WARN',
      detail: `deprecated key: rows in "${file}" are not moved yet. Start the gateway once with this key set, then remove it (note)`,
    });
  });

  it('does not claim either state when the receipt database could not be read', () => {
    const file = join(dir, 'ap2.sqlite');
    writeFileSync(file, '');
    expect(legacyStoreCheck('AP2 replay store', 'ap2-replay', file, undefined)).toEqual({
      name: 'AP2 replay store',
      status: 'WARN',
      detail: `deprecated key: start imports "${file}" into the receipt database once; the receipt database could not be read to tell whether it has`,
    });
  });

  it('reports an import recorded for an in-memory key as moved, since start compares no path', () => {
    const check = legacyStoreCheck('AP2 replay store', 'ap2-replay', ':memory:', [imported]);
    expect(check.status).toBe('WARN');
    expect(check.detail).toContain('3 row(s) moved');
  });

  // Root bypasses file permissions, so a read-only file stays writable for it
  it.skipIf(process.getuid?.() === 0)(
    'fails an unimported file this user cannot write, even when the import state is unknown',
    () => {
      const file = join(dir, 'ap2.sqlite');
      writeFileSync(file, '');
      chmodSync(file, 0o444);
      for (const imports of [[], undefined]) {
        expect(legacyStoreCheck('AP2 replay store', 'ap2-replay', file, imports)).toEqual({
          name: 'AP2 replay store',
          status: 'FAIL',
          detail: `"${file}" exists but is not writable by this user, so the first start cannot lock the file to import it`,
        });
      }
    },
  );
});

describe('runDoctor: checks from the store summary', () => {
  const receipts = ':memory:';
  const withSummary = (summary: Partial<SqliteReceiptStoreSummary>, seen?: unknown[]) => () => ({
    ...makeFakeReceiptStore(),
    summary: async (options: { readonly orphanHoldMinAgeMs: number }) => {
      seen?.push(options);
      return { ...EMPTY_SUMMARY, ...summary };
    },
  });

  it('passes Transactions when nothing is unresolved, adding no hold or claim check', async () => {
    const report = await doctorWith(acpConfig(receipts), withSummary({}));

    expect(check(report, 'Transactions')).toEqual({
      name: 'Transactions',
      status: 'PASS',
      detail: 'none unresolved',
    });
    expect(check(report, 'Authorization holds')).toBeUndefined();
    expect(check(report, 'ACP claims')).toBeUndefined();
  });

  it('warns with the count of each unresolved state and where to resolve them', async () => {
    const report = await doctorWith(
      acpConfig(receipts),
      withSummary({ unresolvedTransactions: { 'settlement-uncertain': 2, 'backend-pending': 1 } }),
    );

    expect(check(report, 'Transactions')).toEqual({
      name: 'Transactions',
      status: 'WARN',
      detail:
        'unresolved: settlement-uncertain=2, backend-pending=1; see GET /api/transactions?unresolved=true or run agent-commerce reconcile',
    });
  });

  it("counts orphan holds at reconcile's default age and warns that they block mandates", async () => {
    const seen: unknown[] = [];
    const report = await doctorWith(acpConfig(receipts), withSummary({ orphanHolds: 3 }, seen));

    expect(seen).toEqual([{ orphanHoldMinAgeMs: FIFTEEN_MINUTES_MS }]);
    expect(check(report, 'Authorization holds')).toEqual({
      name: 'Authorization holds',
      status: 'WARN',
      detail:
        '3 reserved hold(s) older than 15 min have no payment attempt and keep their mandates blocked; agent-commerce reconcile releases them while their authorization method is enabled',
    });
  });

  it('reports unresolved ACP claims as INFO, which does not count against the score', async () => {
    const report = await doctorWith(
      acpConfig(receipts),
      withSummary({ unresolvedIdempotencyKeys: 2 }),
    );

    expect(check(report, 'ACP claims')).toEqual({
      name: 'ACP claims',
      status: 'INFO',
      detail: '2 unresolved; a retry with the same Idempotency-Key gets 409 idempotency_unresolved',
    });
  });

  it('adds no summary check, and leaves the import state unknown, when the summary throws', async () => {
    const file = join(dir, 'acp.sqlite');
    writeFileSync(file, '');
    const report = await doctorWith(acpConfig(receipts, file), () => ({
      ...makeFakeReceiptStore(),
      summary: async () => {
        throw new Error('disk I/O error');
      },
    }));

    expect(check(report, 'Storage')?.status).toBe('PASS');
    expect(check(report, 'Transactions')).toBeUndefined();
    expect(check(report, 'ACP idempotency')?.detail).toContain('could not be read');
  });

  it('adds no summary check for a store without summary()', async () => {
    const report = await doctorWith(acpConfig(receipts), () => makeFakeReceiptStore());

    expect(check(report, 'Storage')?.status).toBe('PASS');
    expect(check(report, 'Transactions')).toBeUndefined();
  });
});

describe('runDoctor: the receipt database is read, never changed', () => {
  let receipts: string;
  let acp: string;
  beforeEach(() => {
    receipts = join(dir, 'receipts.sqlite');
    acp = join(dir, 'acp.sqlite');
    writeFileSync(acp, '');
  });

  function seedV4(): void {
    const db = new Database(receipts);
    db.exec(FIXTURE_V4);
    db.close();
  }

  async function seedV5(legacy?: { readonly acpIdempotency: string }): Promise<void> {
    const store = createSqliteReceiptStore({
      path: receipts,
      ...(legacy !== undefined ? { legacyStores: { ...legacy, enabled: { acp: true } } } : {}),
    });
    await store.init();
    await store.close();
  }

  const version = () => readDb(receipts, (db) => db.pragma('user_version', { simple: true }));
  const imports = () => readDb(receipts, (db) => db.prepare('SELECT * FROM legacy_imports').all());

  it('warns before the next start migrates a v4 database, and leaves it at v4', async () => {
    seedV4();
    const before = sha(receipts);

    const report = await doctorWith(acpConfig(receipts, acp));

    expect(check(report, 'Storage')).toEqual({
      name: 'Storage',
      status: 'WARN',
      detail:
        'sqlite schema v4; the next start migrates it to v5, which earlier versions cannot open. Run agent-commerce backup first to keep a copy they can',
    });
    // The v4 fixture has no import record for the legacy file
    expect(check(report, 'ACP idempotency')?.detail).toContain('are not moved yet');
    expect(check(report, 'Transactions')).toBeUndefined();
    expect(sha(receipts)).toBe(before);
    expect(version()).toBe(4);
  });

  it('reads a v5 database without importing a deprecated file it has not imported', async () => {
    await seedV5();
    const before = sha(receipts);

    const report = await doctorWith(acpConfig(receipts, acp));

    expect(check(report, 'Storage')).toEqual({
      name: 'Storage',
      status: 'PASS',
      detail: 'sqlite schema v5 writable; receipts=0',
    });
    expect(check(report, 'Transactions')?.status).toBe('PASS');
    expect(check(report, 'ACP idempotency')?.detail).toBe(
      `deprecated key: rows in "${acp}" are not moved yet. Start the gateway once with this key set, then remove it (retention 24h)`,
    );
    expect(sha(receipts)).toBe(before);
    expect(imports()).toEqual([]);
  });

  it('reports the import that start recorded', async () => {
    await seedV5({ acpIdempotency: acp });
    const [marker] = imports() as { imported_at: string }[];

    const report = await doctorWith(acpConfig(receipts, acp));

    expect(check(report, 'ACP idempotency')).toEqual({
      name: 'ACP idempotency',
      status: 'WARN',
      detail: `deprecated key: 0 row(s) moved into the receipt database at ${marker?.imported_at}; remove the key (retention 24h)`,
    });
  });

  it('fails a database a newer version wrote, and leaves its version alone', async () => {
    await seedV5();
    const db = new Database(receipts);
    db.pragma('user_version = 6');
    db.close();

    const report = await doctorWith(acpConfig(receipts));

    expect(check(report, 'Storage')).toEqual({
      name: 'Storage',
      status: 'FAIL',
      detail:
        'sqlite schema v6 is newer than this version reads (v5); run the version that wrote it',
    });
    expect(version()).toBe(6);
    expect(report.exitCode).toBe(1);
  });

  it('fails a file that is not a database, leaving it unchanged', async () => {
    writeFileSync(receipts, 'not a database, padded past the 100-byte SQLite header '.repeat(4));
    const before = sha(receipts);

    const report = await doctorWith(acpConfig(receipts));

    expect(check(report, 'Storage')?.status).toBe('FAIL');
    expect(check(report, 'Storage')?.detail).toContain('cannot be opened');
    expect(sha(receipts)).toBe(before);
  });

  it('creates nothing for a missing database, and treats its deprecated file as not moved', async () => {
    const report = await doctorWith(acpConfig(receipts, acp));

    expect(check(report, 'Storage')?.status).toBe('WARN');
    expect(check(report, 'ACP idempotency')?.detail).toContain('are not moved yet');
    expect(existsSync(receipts)).toBe(false);
  });
});
