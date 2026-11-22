// Test schema v6 upgrades using a fixed 2.8.0 (schema v5) SQL fixture
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { SCHEMA_VERSION } from '../../../src/storage/receipts/schema';
import { dumpTables } from '../../fixtures/sqlite-dump';
import { createFakeClock, createFakeIds } from './helpers';

const FIXTURE = readFileSync(new URL('./fixtures/receipts-v5.sql', import.meta.url), 'utf8');
const DEPLOYMENT = 'https://gateway.example';

const versionOf = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
};

describe('schema v6 migration', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-v6-'));
    path = join(dir, 'receipts.sqlite');
    const v5 = new Database(path);
    v5.exec(FIXTURE);
    v5.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const open = () =>
    createSqliteReceiptStore({ path, clock: createFakeClock(), ids: createFakeIds() });

  it('upgrades a 2.8.0 file and leaves every existing row unchanged', async () => {
    const before = dumpTables(path);
    expect(versionOf(path)).toBe(5);
    expect(before['authorization_holds']).toHaveLength(2);
    expect(before['idempotency_keys']).toHaveLength(2);
    expect(before['pending_tasks']).toHaveLength(1);
    expect(before['transactions']).toHaveLength(5);

    const store = open();
    try {
      await store.init();
    } finally {
      await store.close();
    }

    const { task_records: added, ...existing } = dumpTables(path);
    expect(versionOf(path)).toBe(SCHEMA_VERSION);
    expect(added).toEqual([]);
    expect(existing).toStrictEqual(before);
  });

  it('reads the 2.8.0 records back and stores task records in the upgraded file', async () => {
    const store = open();
    try {
      await store.init();
      expect(await store.getPendingTask('a2a_v5_pending')).toEqual({
        id: 'a2a_v5_pending',
        protocol: 'a2a',
        resourceId: 'resource.report',
        input: { symbol: 'ETH' },
        adapterData: { contextId: 'a2a-ctx_v5', messageId: 'msg-v5' },
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
      expect(await store.getAuthorizationHoldState('sha256:mandate_v5_reserved')).toBe('reserved');
      expect(await store.getAuthorizationHoldState('sha256:mandate_v5_consumed')).toBe('consumed');
      const acp = { deployment: DEPLOYMENT, endpoint: '/checkout_sessions', key: 'acp-key-v5' };
      expect(await store.getIdempotencyKey(acp, 'sha256:fp_acp')).toEqual({
        kind: 'replay',
        status: 201,
        body: { id: 'cs_v5' },
      });
      const retry = {
        deployment: DEPLOYMENT,
        endpoint: 'payment:resource.report',
        key: 'retry-v5',
      };
      expect(await store.getIdempotencyKey(retry, 'sha256:fp_retry')).toEqual({
        kind: 'in-flight',
        owner: 'sha256:proof_v5',
      });

      const record = {
        id: 'task_v6',
        protocol: 'a2a' as const,
        groupId: 'ctx_v6',
        state: 'TASK_STATE_COMPLETED',
        updatedAt: '2026-01-01T00:00:01.000Z',
        document: { id: 'task_v6' },
        expiresAt: '2026-01-02T00:00:00.000Z',
      };
      expect(await store.putTaskRecord(record, { maxRecords: 1 })).toBe(true);
      expect(await store.listTaskRecords({ protocol: 'a2a', groupId: 'ctx_v6' })).toEqual([record]);
    } finally {
      await store.close();
    }
  });
});
