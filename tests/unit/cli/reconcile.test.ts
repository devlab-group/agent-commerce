// Reconcile CLI validation, startup failures and report formats
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    });
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
