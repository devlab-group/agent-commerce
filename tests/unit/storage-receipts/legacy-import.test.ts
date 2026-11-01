// Test imports from deprecated AP2 replay and ACP idempotency files. Build
// standard legacy files with the 2.x store factories and start the receipt
// database from the 2.5.0 (schema v4) fixture.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAp2ReplayStore } from '../../../src/authorization/ap2/replay-store';
import type { Logger } from '../../../src/core';
import { createAcpIdempotencyStore } from '../../../src/protocols/acp/idempotency/store';
import {
  createSqliteReceiptStore,
  type LegacyStoreOptions,
  type SqliteReceiptStore,
} from '../../../src/storage/receipts';
import {
  type ConformanceClock,
  createConformanceClock,
  START_MS,
} from '../../../src/testing/conformance/support';
import { dumpTables } from '../../fixtures/sqlite-dump';

const FIXTURE = readFileSync(new URL('./fixtures/receipts-v4.sql', import.meta.url), 'utf8');
const HOUR = 3_600_000;
const SCOPE = (key: string) => ({
  deployment: 'https://gw.test',
  endpoint: '/checkout_sessions',
  key,
});
const MANDATE = (n: number) => ({
  reference: `sha256:ref_${n}`,
  checkoutJti: `jti_${n}`,
  mandateIssuer: 'did:web:wallet.test',
  checkoutIssuer: 'did:web:merchant.test',
  resourceId: 'market_report',
  requestId: `req_${n}`,
});
const BODY = { id: 'cs_1', status: 'ready_for_payment' };

interface Logged {
  level: 'info' | 'warn';
  obj: Record<string, unknown>;
  msg?: string;
}

function recordingLogger(): Logger & { lines: Logged[] } {
  const lines: Logged[] = [];
  const logger: Logger & { lines: Logged[] } = {
    lines,
    debug: () => {},
    info: (obj, msg) => lines.push({ level: 'info', obj, ...(msg !== undefined ? { msg } : {}) }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, ...(msg !== undefined ? { msg } : {}) }),
    error: () => {},
    child: () => logger,
  };
  return logger;
}

// The four AP2 states, as a 2.5 gateway leaves them
function writeAp2File(path: string): void {
  const old = createAp2ReplayStore({ path, now: () => START_MS });
  for (const n of [1, 2, 3, 4]) old.reserve(MANDATE(n));
  old.consume('sha256:ref_2', 'req_2');
  old.release('sha256:ref_3', 'req_3');
  old.markUncertain('sha256:ref_4', 'req_4');
  old.close();
}

// Completed, unresolved and in-flight claims from a 2.5 store
function writeAcpFile(path: string): void {
  const old = createAcpIdempotencyStore({ path, retentionHours: 24, now: () => START_MS });
  old.claim(SCOPE('done'), 'fp');
  old.complete(SCOPE('done'), { status: 201, body: BODY });
  old.claim(SCOPE('unknown'), 'fp');
  old.markUnresolved(SCOPE('unknown'));
  old.claim(SCOPE('running'), 'fp');
  old.close();
}

describe('import of deprecated store files', () => {
  let dir: string;
  let receipts: string;
  let ap2: string;
  let acp: string;
  let clock: ConformanceClock;
  let logger: ReturnType<typeof recordingLogger>;
  let store: SqliteReceiptStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-legacy-'));
    receipts = join(dir, 'receipts.sqlite');
    ap2 = join(dir, 'ap2-replay.sqlite');
    acp = join(dir, 'acp-idempotency.sqlite');
    clock = createConformanceClock();
    logger = recordingLogger();
    // A 2.5.0 deployment that ran both features
    const v4 = new Database(receipts);
    v4.exec(FIXTURE);
    v4.exec(`UPDATE receipts SET authorization_json = '{"method":"ap2","reference":"sha256:ref_2"}'
              WHERE rowid = 1;
             INSERT INTO events (id, type, request_id, at, adapter)
              VALUES ('event_acp', 'resource.requested', 'req_acp', '2026-10-01T10:00:00.000Z', 'acp');`);
    v4.close();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (legacyStores: LegacyStoreOptions) => {
    await store?.close();
    store = createSqliteReceiptStore({ path: receipts, clock, logger, legacyStores });
    await store.init();
    return store;
  };
  const both = (): LegacyStoreOptions => ({
    ap2Replay: ap2,
    acpIdempotency: acp,
    enabled: { ap2: true, acp: true },
  });
  const markers = () => dumpTables(receipts).legacy_imports;

  it('upgrades a 2.5.0 deployment in place, and every row keeps its effect', async () => {
    writeAp2File(ap2);
    writeAcpFile(acp);
    const s = await start(both());

    // AP2 imports preserve states, bindings and issuers
    expect(
      await s.listOrphanAuthorizationHolds({ updatedBefore: '2027-01-01T00:00:00.000Z' }),
    ).toEqual([
      {
        method: 'ap2',
        reference: 'sha256:ref_1',
        bindingReference: 'jti_1',
        resourceId: 'market_report',
        requestId: 'req_1',
        metadata: { mandateIssuer: 'did:web:wallet.test', checkoutIssuer: 'did:web:merchant.test' },
        state: 'reserved',
        createdAt: new Date(START_MS).toISOString(),
        updatedAt: new Date(START_MS).toISOString(),
      },
    ]);
    const hold = (n: number, overrides = {}) => ({
      method: 'ap2' as const,
      ...MANDATE(n),
      bindingReference: `jti_${n}`,
      ...overrides,
    });
    expect(await s.reserveAuthorizationHold(hold(1, { requestId: 'req_new' }))).toEqual({
      kind: 'replayed',
      state: 'reserved',
    });
    expect(await s.reserveAuthorizationHold(hold(2, { requestId: 'req_new' }))).toEqual({
      kind: 'replayed',
      state: 'consumed',
    });
    expect(await s.reserveAuthorizationHold(hold(4, { requestId: 'req_new' }))).toEqual({
      kind: 'replayed',
      state: 'uncertain',
    });
    // A second mandate on a live checkout is refused through the binding
    expect(
      await s.reserveAuthorizationHold(
        hold(9, { bindingReference: 'jti_2', requestId: 'req_new' }),
      ),
    ).toEqual({ kind: 'replayed', state: 'consumed' });
    // Re-reserve the released mandate; the original holder of another mandate
    // can still consume its own hold
    expect(await s.reserveAuthorizationHold(hold(3, { requestId: 'req_new' }))).toEqual({
      kind: 'reserved',
    });
    expect(await s.transitionAuthorizationHold('sha256:ref_1', 'consumed', 'req_1')).toBe(true);

    // Completed ACP claims replay until their original expiry; unresolved
    // claims refuse retries. In-flight claims remain until explicit recovery.
    const in25h = new Date(START_MS + 25 * HOUR).toISOString();
    expect(await s.claimIdempotencyKey(SCOPE('done'), 'fp', in25h)).toEqual({
      kind: 'replay',
      status: 201,
      body: BODY,
    });
    expect(await s.claimIdempotencyKey(SCOPE('done'), 'other', in25h)).toEqual({
      kind: 'conflict',
    });
    expect(await s.claimIdempotencyKey(SCOPE('unknown'), 'fp', in25h)).toEqual({
      kind: 'unresolved',
    });
    expect(await s.claimIdempotencyKey(SCOPE('running'), 'fp', in25h)).toEqual({
      kind: 'in-flight',
    });
    expect(await s.recoverIdempotencyKeys({ release: false })).toBe(1);
    expect(await s.claimIdempotencyKey(SCOPE('running'), 'fp', in25h)).toEqual({
      kind: 'unresolved',
    });
    clock.advance(25 * HOUR);
    expect(await s.claimIdempotencyKey(SCOPE('done'), 'fp', in25h)).toEqual({ kind: 'reserved' });

    expect((await s.summary({ orphanHoldMinAgeMs: 0 })).legacyImports).toEqual([
      {
        source: 'acp-idempotency',
        path: acp,
        rows: 3,
        importedAt: new Date(START_MS).toISOString(),
      },
      { source: 'ap2-replay', path: ap2, rows: 4, importedAt: new Date(START_MS).toISOString() },
    ]);
  });

  it('leaves the legacy files unchanged during the import and after shutdown', async () => {
    writeAp2File(ap2);
    writeAcpFile(acp);
    const before = { ap2: dumpTables(ap2), acp: dumpTables(acp) };

    await start(both());
    expect({ ap2: dumpTables(ap2), acp: dumpTables(acp) }).toEqual(before);
    await store?.close();
    store = undefined;
    expect({ ap2: dumpTables(ap2), acp: dumpTables(acp) }).toEqual(before);
  });

  it('imports nothing on a second start, even rows added to the file since', async () => {
    writeAp2File(ap2);
    await start({ ap2Replay: ap2 });
    const first = markers();
    await store?.close();
    store = undefined;

    const old = createAp2ReplayStore({ path: ap2 });
    old.reserve(MANDATE(5));
    old.close();
    const s = await start({ ap2Replay: ap2 });

    expect(markers()).toEqual(first);
    expect(await s.getAuthorizationHoldState('sha256:ref_5')).toBeUndefined();
  });

  it('refuses a source whose path changed after its import, naming both files', async () => {
    writeAp2File(ap2);
    await start({ ap2Replay: ap2 });
    const copy = join(dir, 'copy.sqlite');
    copyFileSync(ap2, copy);

    await expect(start({ ap2Replay: copy })).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      details: { key: 'authorization.ap2.replay.path', path: copy, importedPath: ap2 },
    });
  });

  it('refuses a legacy path that names the receipt database', async () => {
    await expect(start({ acpIdempotency: receipts })).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      details: { key: 'protocols.acp.idempotency.path', path: receipts },
    });
    expect(markers()).toEqual([]);
  });

  it('aborts on a corrupt file with no marker and no rows, and the next start retries', async () => {
    writeFileSync(ap2, 'not a sqlite database, but long enough to be read as one'.repeat(20));

    await expect(start({ ap2Replay: ap2 })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    let tables = dumpTables(receipts);
    expect(tables.legacy_imports).toEqual([]);
    expect(tables.authorization_holds).toEqual([]);

    rmSync(ap2);
    writeAp2File(ap2);
    const s = await start({ ap2Replay: ap2 });
    expect(await s.getAuthorizationHoldState('sha256:ref_2')).toBe('consumed');
    tables = dumpTables(receipts);
    expect(tables.legacy_imports).toHaveLength(1);
  });

  it('rolls back the rows and the marker together when one row cannot be stored', async () => {
    // Hand-built without the 2.x NOT NULL constraints, so a row lacks its resource
    const file = new Database(ap2);
    file.exec(`CREATE TABLE ap2_authorizations (reference TEXT, checkout_jti TEXT, mandate_issuer TEXT,
                 checkout_issuer TEXT, resource_id TEXT, request_id TEXT, state TEXT,
                 created_at TEXT, updated_at TEXT);
               INSERT INTO ap2_authorizations VALUES
                 ('sha256:ok', 'jti_ok', 'i', 'i', 'r', 'req', 'consumed', 't', 't'),
                 ('sha256:bad', 'jti_bad', 'i', 'i', NULL, 'req', 'consumed', 't', 't');`);
    file.close();

    await expect(start({ ap2Replay: ap2 })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    const tables = dumpTables(receipts);
    expect(tables.legacy_imports).toEqual([]);
    expect(tables.authorization_holds).toEqual([]);
  });

  it('releases the lock it took when a later source fails', async () => {
    writeAp2File(ap2);
    mkdirSync(acp);

    await expect(start({ ap2Replay: ap2, acpIdempotency: acp })).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
    // The AP2 file is writable again, so nothing holds its lock
    const old = createAp2ReplayStore({ path: ap2 });
    try {
      expect(old.reserve(MANDATE(6))).toEqual({ kind: 'reserved' });
    } finally {
      old.close();
    }
  });

  it('refuses a file it cannot open before its import, naming both fixes', async () => {
    // Use a directory to trigger SQLITE_CANTOPEN
    mkdirSync(ap2);

    const err = await start({ ap2Replay: ap2 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'STORAGE_ERROR', details: { path: ap2 } });
    expect((err as Error).message).toMatch(/directory writable/);
    expect((err as Error).message).toMatch(/copy the file/);
    expect(markers()).toEqual([]);
  });

  it('starts with a warning when an imported file can no longer be opened', async () => {
    writeAp2File(ap2);
    await start({ ap2Replay: ap2 });
    await store?.close();
    store = undefined;
    rmSync(ap2);
    mkdirSync(ap2);

    const s = await start({ ap2Replay: ap2 });
    expect(await s.getAuthorizationHoldState('sha256:ref_2')).toBe('consumed');
    expect(logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        obj: { key: 'authorization.ap2.replay.path', path: ap2 },
      }),
    );
  });

  it('imports nothing from an ACP schema v1 file and logs the open claims it drops', async () => {
    const v1 = new Database(acp);
    v1.exec(`CREATE TABLE acp_idempotency (token_digest TEXT, idempotency_key TEXT, state TEXT);
             INSERT INTO acp_idempotency VALUES ('d', 'k1', 'completed'), ('d', 'k2', 'in_flight'),
                                                ('d', 'k3', 'unresolved');
             PRAGMA user_version = 1;`);
    v1.close();

    await start({ acpIdempotency: acp });
    expect(dumpTables(receipts).idempotency_keys).toEqual([]);
    expect(markers()).toEqual([
      {
        source: 'acp-idempotency',
        path: acp,
        rows: 0,
        imported_at: new Date(START_MS).toISOString(),
      },
    ]);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: 'warn', obj: { unresolved: 2 } }),
    );
  });

  it('keeps a held reference blocked when the file has the same one released', async () => {
    const old = createAp2ReplayStore({ path: ap2, now: () => START_MS });
    old.reserve(MANDATE(1));
    old.release('sha256:ref_1', 'req_1');
    old.reserve(MANDATE(2));
    old.consume('sha256:ref_2', 'req_2');
    old.close();
    // The store already holds ref_1 and has ref_2 released
    const s = createSqliteReceiptStore({ path: receipts, clock });
    await s.init();
    const hold = (n: number) => ({
      method: 'ap2' as const,
      ...MANDATE(n),
      bindingReference: `jti_${n}`,
    });
    await s.reserveAuthorizationHold(hold(1));
    await s.reserveAuthorizationHold(hold(2));
    await s.transitionAuthorizationHold('sha256:ref_2', 'released', 'req_2');
    await s.close();

    const after = await start({ ap2Replay: ap2 });
    expect(await after.getAuthorizationHoldState('sha256:ref_1')).toBe('reserved');
    expect(await after.getAuthorizationHoldState('sha256:ref_2')).toBe('consumed');
  });

  describe('forgotten-key guard', () => {
    it.each([
      ['ap2', 'authorization.ap2.replay.path'],
      ['acp', 'protocols.acp.idempotency.path'],
    ] as const)('refuses %s used before with no key, naming %s', async (feature, key) => {
      await expect(start({ enabled: { [feature]: true } })).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
        details: { key },
      });
      expect(markers()).toEqual([]);
    });

    it('refuses a key that names a missing file', async () => {
      await expect(start({ ap2Replay: ap2, enabled: { ap2: true } })).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
        details: { key: 'authorization.ap2.replay.path', path: ap2 },
      });
    });

    it('accepts the loss when the key names an empty file', async () => {
      writeFileSync(ap2, '');
      writeFileSync(acp, '');

      await start(both());
      // In import order: AP2 first
      expect(markers()).toEqual([
        { source: 'ap2-replay', path: ap2, rows: 0, imported_at: new Date(START_MS).toISOString() },
        {
          source: 'acp-idempotency',
          path: acp,
          rows: 0,
          imported_at: new Date(START_MS).toISOString(),
        },
      ]);
      // Recorded, so the next start needs no key
      await start({ enabled: { ap2: true, acp: true } });
    });

    it('lets a feature start that is disabled, unused, or already holds rows', async () => {
      await start({ enabled: {} });
      const fresh = join(dir, 'fresh.sqlite');
      store = createSqliteReceiptStore({
        path: fresh,
        clock,
        legacyStores: { enabled: { ap2: true, acp: true } },
      });
      await store.init();
      await store.reserveAuthorizationHold({
        method: 'ap2',
        ...MANDATE(1),
        bindingReference: 'jti_1',
      });
      await store.claimIdempotencyKey(SCOPE('k'), 'fp', '2027-01-01T00:00:00.000Z');
      await store.close();
      store = undefined;

      // The 2.5.0 deployment, once its new tables hold rows
      const seeded = createSqliteReceiptStore({ path: receipts, clock });
      await seeded.init();
      await seeded.reserveAuthorizationHold({
        method: 'ap2',
        ...MANDATE(1),
        bindingReference: 'jti_1',
      });
      await seeded.claimIdempotencyKey(SCOPE('k'), 'fp', '2027-01-01T00:00:00.000Z');
      await seeded.close();
      await start({ enabled: { ap2: true, acp: true } });
    });
  });

  it('write-locks the files: a 2.5 gateway in another process cannot reserve or open its ACP store', async () => {
    writeAp2File(ap2);
    writeAcpFile(acp);
    await start(both());

    const script = join(dir, 'old-gateway.ts');
    const repo = new URL('../../../', import.meta.url).pathname;
    writeFileSync(
      script,
      `import { createAp2ReplayStore } from '${repo}src/authorization/ap2/replay-store';
       import { createAcpIdempotencyStore } from '${repo}src/protocols/acp/idempotency/store';
       const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code; } };
       const ap2 = createAp2ReplayStore({ path: ${JSON.stringify(ap2)} });
       const read = code(() => ap2.stateOf('sha256:ref_2'));
       const reserve = code(() => ap2.reserve(${JSON.stringify(MANDATE(7))}));
       const acpOpen = code(() => createAcpIdempotencyStore({ path: ${JSON.stringify(acp)}, retentionHours: 24 }));
       console.log(JSON.stringify({ read, reserve, acpOpen }));`,
    );
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: repo });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('exit', () => resolve(out));
    });

    expect(JSON.parse(output)).toEqual({
      read: 'ok',
      reserve: 'SQLITE_BUSY',
      acpOpen: 'SQLITE_BUSY',
    });
    expect(dumpTables(ap2).ap2_authorizations).toHaveLength(4);
  }, 30_000);
});
