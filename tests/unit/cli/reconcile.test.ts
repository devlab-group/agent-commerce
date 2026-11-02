// Reconcile CLI validation, startup failures and report formats
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDuration, runReconcileCommand } from '../../../src/cli/commands/reconcile';
import { CommerceError } from '../../../src/core';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { createCapturingIo, makeGatewayConfig } from './fixtures';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oac-reconcile-'));
  tempDirs.push(dir);
  return dir;
}

// Create one uncertain x402 attempt and a config pointing to its database
async function seededConfig() {
  const path = join(tempDir(), 'receipts.sqlite');
  const store = createSqliteReceiptStore({ path });
  await store.init();
  const attempt = await store.reservePaymentAttempt({
    requestId: 'req_1',
    resourceId: 'resource.report',
    provider: 'x402',
    replayKey: 'replay_1',
    amount: '0.01',
    currency: 'USDC',
    transaction: { id: 'txn_1', protocol: 'http', configDigest: 'sha256:0' },
  });
  await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settlement-uncertain' });
  await store.close();
  const config = makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path } } });
  return { config, attempt };
}

describe('parseDuration', () => {
  it.each([
    ['0', 0],
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
  ])('reads %s as %i ms', (value, ms) => {
    expect(parseDuration(value)).toBe(ms);
  });

  it.each(['15', '-1m', '1.5h', '', '15 m', '15min', '1w'])('refuses %j', (value) => {
    expect(parseDuration(value)).toBeNull();
  });
});

describe('runReconcileCommand flag checks', () => {
  it.each([
    [{ minAge: '15min' }, '--min-age must be a duration'],
    [{ limit: '0' }, '--limit must be a positive integer'],
    [{ limit: '1.5' }, '--limit must be a positive integer'],
    [{ actor: ' ' }, '--actor must not be empty'],
  ])('exits 1 for %j before reading config', async (options, message) => {
    const io = createCapturingIo();
    const loadConfig = vi.fn();

    const code = await runReconcileCommand(options, io, { loadConfig });

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain(message);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('exits 1 with the config error', async () => {
    const io = createCapturingIo();
    const loadConfig = async () => {
      throw new CommerceError('CONFIG_INVALID', 'bad config', { details: { path: 'payments' } });
    };

    expect(await runReconcileCommand({}, io, { loadConfig })).toBe(1);
    expect(io.err.join('\n')).toContain('FAIL  CONFIG_INVALID: bad config');
  });

  it('exits 1 when the receipt database cannot be opened', async () => {
    const io = createCapturingIo();
    // A directory cannot be opened as a database file
    const config = makeGatewayConfig({
      storage: { receipts: { driver: 'sqlite', path: tempDir() } },
    });

    expect(await runReconcileCommand({}, io, { loadConfig: async () => config })).toBe(1);
    expect(io.err.join('\n')).toContain('FAIL  reconcile could not run');
  });

  it('refuses a 2.5 database without migrating it', async () => {
    const path = join(tempDir(), 'receipts.sqlite');
    const v4 = new Database(path);
    v4.exec(
      readFileSync(
        new URL('../storage-receipts/fixtures/receipts-v4.sql', import.meta.url),
        'utf8',
      ),
    );
    v4.close();
    const config = makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path } } });
    const io = createCapturingIo();

    expect(await runReconcileCommand({}, io, { loadConfig: async () => config })).toBe(1);
    expect(io.err.join('\n')).toMatch(/schema v4.*agent-commerce backup/);
    const after = new Database(path, { readonly: true });
    try {
      // Preserve schema v4 so a 2.5 gateway can still open the file
      expect(after.pragma('user_version', { simple: true })).toBe(4);
    } finally {
      after.close();
    }
  });
});

describe('runReconcileCommand report', () => {
  it('lists an attempt whose provider is not enabled and exits 0', async () => {
    const { config, attempt } = await seededConfig();
    const io = createCapturingIo();

    const code = await runReconcileCommand({}, io, { loadConfig: async () => config });

    expect(code).toBe(0);
    expect(io.out).toEqual([
      'reconcile: 1 candidates, 0 settled, 0 not settled, 1 unknown, 0 resolved',
      `UNKNOWN     ${attempt.id} request=req_1 provider=x402 status=settlement-uncertain reason=provider_not_enabled`,
    ]);
    expect(io.err).toEqual([]);
  });

  it('prints parseable JSON with counts, and marks a dry run', async () => {
    const { config, attempt } = await seededConfig();
    const io = createCapturingIo();

    await runReconcileCommand({ json: true, dryRun: true }, io, { loadConfig: async () => config });

    expect(JSON.parse(io.out.join('\n'))).toEqual({
      dryRun: true,
      counts: {
        candidates: 1,
        settled: 0,
        notSettled: 0,
        unknown: 1,
        resolved: 0,
        holdsAligned: 0,
        orphanHolds: 0,
        orphanHoldsReleased: 0,
      },
      entries: [
        {
          attemptId: attempt.id,
          transactionId: 'txn_1',
          requestId: 'req_1',
          provider: 'x402',
          status: 'settlement-uncertain',
          outcome: 'unknown',
          reason: 'provider_not_enabled',
          written: false,
        },
      ],
      holds: [],
      orphanHolds: [],
      failedScans: [],
    });
  });

  it('prints the saved resolutions and exits 1 when a hold scan fails', async () => {
    const { config, attempt } = await seededConfig();
    const ap2 = {
      enabled: true,
      trust: { mandateIssuers: [], checkoutIssuers: [] },
    } as unknown as NonNullable<NonNullable<typeof config.authorization>['ap2']>;
    const io = createCapturingIo();
    // Inject a failure when the command reads orphan holds
    const { createSqliteReceiptStore: real } = await import('../../../src/storage/receipts');
    const spy = vi
      .spyOn(await import('../../../src/storage/receipts'), 'createSqliteReceiptStore')
      .mockImplementation((options) => {
        const store = real(options);
        store.listOrphanAuthorizationHolds = async () => {
          throw new Error('SQLITE_BUSY');
        };
        return store;
      });
    try {
      const code = await runReconcileCommand({}, io, {
        loadConfig: async () => ({ ...config, authorization: { ap2 } }),
      });

      expect(code).toBe(1);
      expect(io.out[1]).toContain(attempt.id);
      expect(io.err.join('\n')).toContain('could not finish the orphan-holds scan');
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves a live gateway's ACP claims and its deprecated ACP file alone", async () => {
    const { config } = await seededConfig();
    const scope = { deployment: 'https://shop.example', endpoint: '/checkout_sessions', key: 'k1' };
    const expiresAt = '2999-01-01T00:00:00.000Z';
    const live = createSqliteReceiptStore({ path: config.storage.receipts.path });
    await live.init();
    expect(await live.claimIdempotencyKey(scope, 'sha256:body', expiresAt)).toEqual({
      kind: 'reserved',
    });
    const acpFile = join(tempDir(), 'acp-idempotency.sqlite');
    writeFileSync(acpFile, '');
    const acp = {
      enabled: true,
      idempotency: { path: acpFile, retentionHours: 24, merchantIdempotent: false },
    } as unknown as NonNullable<typeof config.protocols.acp>;

    try {
      const code = await runReconcileCommand({}, createCapturingIo(), {
        loadConfig: async () => ({ ...config, protocols: { ...config.protocols, acp } }),
      });

      expect(code).toBe(0);
      // Recovery would mark the active claim unresolved; import would add a marker
      expect(await live.claimIdempotencyKey(scope, 'sha256:body', expiresAt)).toEqual({
        kind: 'in-flight',
      });
      expect((await live.summary({ orphanHoldMinAgeMs: 0 })).legacyImports).toEqual([]);
      expect(readFileSync(acpFile)).toHaveLength(0);
    } finally {
      await live.close();
    }
  });

  it('marks a dry run in the text report', async () => {
    const { config } = await seededConfig();
    const io = createCapturingIo();

    await runReconcileCommand({ dryRun: true }, io, { loadConfig: async () => config });

    expect(io.out[0]).toBe(
      'reconcile (dry run, no resolutions written): 1 candidates, 0 settled, 0 not settled, 1 unknown, 0 resolved',
    );
  });
});
