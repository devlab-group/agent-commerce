// SQLite-specific input checks on the 2.6.0 record methods, which the
// conformance suite leaves to each store
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteReceiptStore, type SqliteReceiptStore } from '../../../src/storage/receipts';
import {
  type ConformanceClock,
  createConformanceClock,
  isoAt,
} from '../../../src/testing/conformance/support';
import { dumpTables } from '../../fixtures/sqlite-dump';

const MINUTE = 60_000;
const SCOPE = { deployment: 'https://gateway.test', endpoint: '/checkout_sessions', key: 'k1' };
const task = { id: 'task_1', protocol: 'a2a' as const, resourceId: 'r', input: {} };

describe('SQLite record method inputs', () => {
  let dir: string;
  let path: string;
  let clock: ConformanceClock;
  let store: SqliteReceiptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-inputs-'));
    path = join(dir, 'receipts.sqlite');
    clock = createConformanceClock();
    store = createSqliteReceiptStore({ path, clock });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A NaN cap compares false against every count, so it would admit any number of tasks
  it.each([Number.NaN, -1, 1.5])('refuses maxTasks %s and stores nothing', async (maxTasks) => {
    await expect(
      store.putPendingTask({ ...task, expiresAt: isoAt(MINUTE) }, { maxTasks }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(dumpTables(path).pending_tasks).toEqual([]);
  });

  it('refuses an unparseable timestamp on each method that stores or compares one', async () => {
    await expect(store.claimIdempotencyKey(SCOPE, 'fp', 'not-a-date')).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
    await expect(
      store.putPendingTask({ ...task, expiresAt: 'not-a-date' }, { maxTasks: 10 }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(
      store.listOrphanAuthorizationHolds({ updatedBefore: 'not-a-date' }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    const tables = dumpTables(path);
    expect(tables.idempotency_keys).toEqual([]);
    expect(tables.pending_tasks).toEqual([]);
  });

  // Timestamps are compared as text, so an offset form must be stored as UTC
  it('expires a completed claim at the instant an offset timestamp names', async () => {
    // 01:10+01:00 is 00:10Z, which sorts after 00:20Z as text
    const expiresAt = '2026-01-01T01:10:00+01:00';
    expect(await store.claimIdempotencyKey(SCOPE, 'fp', expiresAt)).toEqual({ kind: 'reserved' });
    await store.updateIdempotencyKey(SCOPE, { kind: 'completed', status: 201, body: { ok: true } });
    clock.advance(20 * MINUTE);
    expect(await store.claimIdempotencyKey(SCOPE, 'fp', isoAt(60 * MINUTE))).toEqual({
      kind: 'reserved',
    });
  });

  it('stops serving a task at the instant an offset timestamp names', async () => {
    expect(
      await store.putPendingTask(
        { ...task, expiresAt: '2026-01-01T01:10:00+01:00' },
        { maxTasks: 1 },
      ),
    ).toBe(true);
    clock.advance(20 * MINUTE);
    expect(await store.getPendingTask('task_1')).toBeUndefined();
  });
});
