// Check consistent receipt and unimported legacy-store copies without
// migrating or importing the sources
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAp2ReplayStore } from '../../../src/authorization/ap2/replay-store';
import { type BackupManifest, runBackupCommand } from '../../../src/cli/commands/backup';
import type { GatewayConfig } from '../../../src/config';
import { createAcpIdempotencyStore } from '../../../src/protocols/acp/idempotency/store';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { dumpTables } from '../../fixtures/sqlite-dump';
import { createCapturingIo, makeGatewayConfig } from './fixtures';

const FIXTURE_V4 = readFileSync(
  new URL('../storage-receipts/fixtures/receipts-v4.sql', import.meta.url),
  'utf8',
);
const NOW = '2026-11-01T12:00:00.000Z';
const clock = { now: () => new Date(NOW), nowIso: () => NOW, monotonicMs: () => 0 };

let dir: string;
let receipts: string;
let ap2: string;
let acp: string;
let out: string;
let writer: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oac-backup-'));
  receipts = join(dir, 'receipts.sqlite');
  ap2 = join(dir, 'ap2.sqlite');
  acp = join(dir, 'acp.sqlite');
  out = join(dir, 'backup');
});

afterEach(() => {
  writer?.kill('SIGKILL');
  writer = undefined;
  rmSync(dir, { recursive: true, force: true });
});

// Enable AP2 and ACP with both legacy paths, as in a 2.5 configuration
function config(): GatewayConfig {
  const base = makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path: receipts } } });
  return {
    ...base,
    protocols: {
      ...base.protocols,
      acp: { enabled: true, idempotency: { path: acp, retentionHours: 24 } },
    },
    authorization: { ap2: { enabled: true, replay: { path: ap2 } } },
  } as unknown as GatewayConfig;
}

async function backup(options: { json?: boolean } = { json: true }) {
  const io = createCapturingIo();
  const code = await runBackupCommand({ out, ...options }, io, {
    loadConfig: async () => config(),
    clock,
  });
  return { code, io };
}

function writeV4(): void {
  const db = new Database(receipts);
  db.exec(FIXTURE_V4);
  db.close();
}

function writeLegacyFiles(): void {
  const replay = createAp2ReplayStore({ path: ap2 });
  replay.reserve({
    reference: 'sha256:ref_1',
    checkoutJti: 'jti_1',
    mandateIssuer: 'did:web:wallet.test',
    checkoutIssuer: 'did:web:merchant.test',
    resourceId: 'market_report',
    requestId: 'req_1',
  });
  replay.close();
  const claims = createAcpIdempotencyStore({ path: acp, retentionHours: 24 });
  claims.claim({ deployment: 'https://gw.test', endpoint: '/checkout_sessions', key: 'k1' }, 'fp');
  claims.close();
}

async function startedOnce(): Promise<void> {
  const store = createSqliteReceiptStore({
    path: receipts,
    legacyStores: { ap2Replay: ap2, acpIdempotency: acp, enabled: { ap2: true, acp: true } },
  });
  await store.init();
  await store.close();
}

function manifest(): BackupManifest {
  return JSON.parse(readFileSync(join(out, 'backup.json'), 'utf8')) as BackupManifest;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('agent-commerce backup', () => {
  it('copies a database a writer is changing into a consistent, owner-only snapshot', async () => {
    await startedOnce();
    const live = new Database(receipts);
    live.exec('CREATE TABLE writer_probe (n INTEGER PRIMARY KEY)');
    live.close();
    // Inserts 0, 1, 2, ... one per transaction until killed
    writer = spawn(
      process.execPath,
      [
        '-e',
        `const db = new (require('better-sqlite3'))(process.argv[1]);
         const insert = db.prepare('INSERT INTO writer_probe (n) VALUES (?)');
         let n = 0;
         insert.run(n++);
         process.stdout.write('ready\\n');
         setInterval(() => insert.run(n++), 1);`,
        receipts,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => writer?.stdout?.once('data', () => resolve()));

    const { code, io } = await backup();

    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const copy = new Database(join(out, 'receipts.sqlite'), { readonly: true });
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      // A prefix of the writer's inserts, with none missing
      const { rows, top } = copy
        .prepare('SELECT COUNT(*) AS rows, MAX(n) AS top FROM writer_probe')
        .get() as { rows: number; top: number };
      expect(rows).toBe(top + 1);
    } finally {
      copy.close();
    }

    expect(manifest()).toEqual({
      packageVersion: expect.any(String),
      createdAt: NOW,
      files: [
        {
          file: 'receipts.sqlite',
          source: 'storage.receipts.path',
          schemaVersion: 5,
          sha256: sha256(join(out, 'receipts.sqlite')),
        },
      ],
    });
    expect(JSON.parse(io.out.join('\n'))).toEqual({ out, ...manifest() });
    expect(mode(out)).toBe(0o700);
    expect(mode(join(out, 'receipts.sqlite'))).toBe(0o600);
    expect(mode(join(out, 'backup.json'))).toBe(0o600);
    // Reopen last: the store switches the copy to WAL but needs no migration
    const reopened = createSqliteReceiptStore({ path: join(out, 'receipts.sqlite') });
    await reopened.init();
    expect((await reopened.health()).detail).toBe('sqlite schema v5 writable');
    await reopened.close();
  });

  it('copies the deprecated files a 2.5 deployment still holds, and leaves every source unchanged', async () => {
    writeV4();
    writeLegacyFiles();
    const before = [receipts, ap2, acp].map(sha256);

    const { code } = await backup({ json: false });

    expect(code).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      'acp-idempotency.sqlite',
      'ap2-replay.sqlite',
      'backup.json',
      'receipts.sqlite',
    ]);
    expect(
      manifest().files.map(({ file, source, schemaVersion }) => [file, source, schemaVersion]),
    ).toEqual([
      ['receipts.sqlite', 'storage.receipts.path', 4],
      ['ap2-replay.sqlite', 'authorization.ap2.replay.path', 1],
      ['acp-idempotency.sqlite', 'protocols.acp.idempotency.path', 2],
    ]);
    expect(dumpTables(join(out, 'ap2-replay.sqlite'))).toEqual(dumpTables(ap2));
    expect(dumpTables(join(out, 'acp-idempotency.sqlite'))).toEqual(dumpTables(acp));
    for (const file of manifest().files) expect(mode(join(out, file.file))).toBe(0o600);
    // Read-only: no migration to v5, no import marker, no rewritten file
    expect([receipts, ap2, acp].map(sha256)).toEqual(before);
  });

  it('skips a deprecated file the receipt database has imported', async () => {
    writeV4();
    writeLegacyFiles();
    await startedOnce();

    expect((await backup()).code).toBe(0);

    expect(manifest().files.map((file) => file.file)).toEqual(['receipts.sqlite']);
  });

  it.each([
    [
      'holds a file',
      () => {
        mkdirSync(out);
        writeFileSync(join(out, 'keep.txt'), 'operator data');
        return out;
      },
    ],
    ['is the live database directory', () => dir],
  ])('refuses an --out that %s, and writes nothing', async (_, target) => {
    await startedOnce();
    out = target();
    const before = readdirSync(out).sort();

    const { code, io } = await backup();

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('is not empty');
    expect(readdirSync(out).sort()).toEqual(before);
  });

  it('refuses an --out that is a file', async () => {
    await startedOnce();
    writeFileSync(out, 'not a directory');

    const { code, io } = await backup();

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('is not a directory');
    expect(readFileSync(out, 'utf8')).toBe('not a directory');
  });

  it.each([3, 6])('refuses a receipt database at schema v%i, copying nothing', async (version) => {
    const db = new Database(receipts);
    db.pragma(`user_version = ${version}`);
    db.close();

    const { code, io } = await backup();

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain(`schema v${version}; this version backs up v4 and v5`);
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses a receipt database that does not exist, without creating it', async () => {
    const { code, io } = await backup();

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('does not exist');
    expect(readdirSync(dir)).toEqual([]);
  });
});
