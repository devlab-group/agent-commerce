// SQLite-specific input checks left to each store by the conformance suite
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
const record = (id: string, updatedAt: string, expiresAt = isoAt(10 * MINUTE)) => ({
  id,
  protocol: 'a2a' as const,
  groupId: 'ctx_1',
  state: 'TASK_STATE_COMPLETED',
  updatedAt,
  document: { id },
  expiresAt,
});

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

  it.each([Number.NaN, -1, 1.5])('refuses maxRecords %s and stores nothing', async (maxRecords) => {
    await expect(
      store.putTaskRecord(record('rec_1', isoAt(0)), { maxRecords }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(dumpTables(path).task_records).toEqual([]);
  });

  it('writes nothing when reading a claim, even one past its expiry', async () => {
    await store.claimIdempotencyKey(SCOPE, 'fp', isoAt(MINUTE));
    await store.updateIdempotencyKey(SCOPE, { kind: 'completed', status: 200, body: {} });
    clock.advance(MINUTE);
    const before = dumpTables(path);

    expect(await store.getIdempotencyKey(SCOPE, 'fp')).toBeUndefined();

    expect(before.idempotency_keys).toHaveLength(1);
    expect(dumpTables(path)).toEqual(before);
  });

  it('answers STORAGE_ERROR when a stored claim body cannot be parsed', async () => {
    await store.claimIdempotencyKey(SCOPE, 'fp', isoAt(MINUTE));
    await store.updateIdempotencyKey(SCOPE, { kind: 'completed', status: 200, body: {} });
    const db = new Database(path);
    db.prepare("UPDATE idempotency_keys SET body_json = '{'").run();
    db.close();

    await expect(store.getIdempotencyKey(SCOPE, 'fp')).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
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
    await expect(
      store.putTaskRecord(record('rec_1', 'not-a-date'), { maxRecords: 10 }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(
      store.putTaskRecord(record('rec_1', isoAt(0), 'not-a-date'), { maxRecords: 10 }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    const tables = dumpTables(path);
    expect(tables.idempotency_keys).toEqual([]);
    expect(tables.pending_tasks).toEqual([]);
    expect(tables.task_records).toEqual([]);
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

  it('stops serving a task record at the instant an offset timestamp names', async () => {
    await store.putTaskRecord(record('rec_1', isoAt(0), '2026-01-01T01:10:00+01:00'), {
      maxRecords: 1,
    });
    clock.advance(20 * MINUTE);
    expect(await store.getTaskRecord('rec_1')).toBeUndefined();
    expect(await store.listTaskRecords({ protocol: 'a2a', groupId: 'ctx_1' })).toEqual([]);
  });

  it('lists task records by the instant an offset updatedAt names', async () => {
    // 00:30+01:00 is 23:30Z the day before; raw timestamp strings sort in the wrong order
    await store.putTaskRecord(record('earlier', '2026-01-01T00:30:00+01:00'), { maxRecords: 2 });
    await store.putTaskRecord(record('later', '2026-01-01T00:10:00.000Z'), { maxRecords: 2 });
    const listed = await store.listTaskRecords({ protocol: 'a2a', groupId: 'ctx_1' });
    expect(listed.map((r) => [r.id, r.updatedAt])).toEqual([
      ['later', '2026-01-01T00:10:00.000Z'],
      ['earlier', '2025-12-31T23:30:00.000Z'],
    ]);
  });

  it('deletes expired task records when a writable store starts', async () => {
    await store.putTaskRecord(record('rec_1', isoAt(0), isoAt(MINUTE)), { maxRecords: 1 });
    await store.close();
    clock.advance(MINUTE + 1);
    store = createSqliteReceiptStore({ path, clock });
    await store.init();
    expect(dumpTables(path).task_records).toEqual([]);
  });
});
