// Resolve CLI and shared AP2 hold updates with the gateway stopped
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAp2ReplayStore } from '../../../src/authorization/ap2/replay-store';
import { runReconcileCommand } from '../../../src/cli/commands/reconcile';
import { runResolveCommand } from '../../../src/cli/commands/resolve';
import type { GatewayConfig } from '../../../src/config';
import { CommerceError } from '../../../src/core';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { createCapturingIo, makeGatewayConfig } from './fixtures';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REFERENCE = 'sha256:M1';

// Seed a payment attempt and optional AP2 hold in their separate databases
async function seeded(options: { ap2?: boolean; settled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oac-resolve-'));
  tempDirs.push(dir);
  const receipts = join(dir, 'receipts.sqlite');
  const replayPath = join(dir, 'ap2.sqlite');
  const store = createSqliteReceiptStore({ path: receipts });
  await store.init();
  const attempt = await store.reservePaymentAttempt({
    requestId: 'req_1',
    resourceId: 'resource.report',
    provider: 'x402',
    replayKey: 'replay_1',
    amount: '0.01',
    currency: 'USDC',
    transaction: {
      id: 'txn_1',
      protocol: 'http',
      configDigest: 'sha256:0',
      ...(options.ap2 === true
        ? { authorization: { method: 'ap2', reference: REFERENCE, reservationId: REFERENCE } }
        : {}),
    },
  });
  await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settlement-uncertain' });
  if (options.ap2 === true) {
    await store.recordTransactionStep?.({
      transactionId: 'txn_1',
      at: new Date().toISOString(),
      kind: 'hold',
      hold: 'uncertain',
    });
    const replay = createAp2ReplayStore({ path: replayPath });
    replay.reserve({
      reference: REFERENCE,
      checkoutJti: 'checkout_1',
      mandateIssuer: 'https://trusted.example',
      checkoutIssuer: 'https://merchant.example',
      resourceId: 'resource.report',
      requestId: 'req_1',
    });
    replay.markUncertain(REFERENCE);
    replay.close();
  }
  if (options.settled === true) {
    await store.resolvePaymentAttempt?.({
      attemptId: attempt.id,
      expectedStatus: 'settlement-uncertain',
      status: 'settled',
      resolution: { method: 'manual', actor: 'ops', reason: 'seen', at: new Date().toISOString() },
    });
  }
  await store.close();
  const config = makeGatewayConfig({
    storage: { receipts: { driver: 'sqlite', path: receipts } },
    ...(options.ap2 === true
      ? {
          authorization: {
            ap2: {
              enabled: true,
              specVersion: '0.2.0',
              mode: 'direct',
              trust: { mandateIssuers: [], checkoutIssuers: [] },
              clockSkewSeconds: 60,
              replay: { path: replayPath },
            },
          } as NonNullable<GatewayConfig['authorization']>,
        }
      : {}),
  });
  const read = async () => {
    const reopened = createSqliteReceiptStore({ path: receipts });
    await reopened.init();
    try {
      return {
        attempt: await reopened.getPaymentAttempt?.(attempt.id),
        hold: (await reopened.getTransaction?.('txn_1'))?.authorization?.hold,
      };
    } finally {
      await reopened.close();
    }
  };
  const mandateState = () => {
    const replay = createAp2ReplayStore({ path: replayPath });
    try {
      return replay.stateOf(REFERENCE);
    } finally {
      replay.close();
    }
  };
  return { config, attempt, read, mandateState };
}

describe('runResolveCommand', () => {
  it('settles an attempt from the CLI and exits 0', async () => {
    const { config, attempt, read } = await seeded();
    const io = createCapturingIo();

    const code = await runResolveCommand(
      attempt.id,
      { status: 'settled', reason: 'found it', reference: '0xfeed', actor: 'alice@ops' },
      io,
      { loadConfig: async () => config },
    );

    expect(code).toBe(0);
    expect(io.out).toEqual([`RESOLVED  ${attempt.id} status=settled`]);
    expect((await read()).attempt).toMatchObject({
      status: 'settled',
      externalReference: '0xfeed',
      resolution: { method: 'manual', actor: 'alice@ops', reason: 'found it' },
    });
  });

  it('exits 1 naming --confirm-expired when no expiry is recorded, then rejects once confirmed', async () => {
    const { config, attempt, read } = await seeded();
    const deps = { loadConfig: async () => config };
    const refused = createCapturingIo();

    expect(
      await runResolveCommand(
        attempt.id,
        { status: 'rejected', reason: 'gone', actor: 'a' },
        refused,
        deps,
      ),
    ).toBe(1);
    expect(refused.err).toEqual([
      `FAIL  ${attempt.id} not resolved: No expiry is recorded for this authorization; confirm that it has expired (pass --confirm-expired) [expiry_unknown, status=settlement-uncertain]`,
    ]);
    expect((await read()).attempt?.status).toBe('settlement-uncertain');

    const io = createCapturingIo();
    expect(
      await runResolveCommand(
        attempt.id,
        { status: 'rejected', reason: 'gone', actor: 'a', confirmExpired: true },
        io,
        deps,
      ),
    ).toBe(0);
    expect((await read()).attempt?.status).toBe('rejected');
  });

  it.each([
    ['an unknown status', 'refunded', 'INPUT_INVALID: status must be "settled" or "rejected"'],
    [
      'an unknown attempt',
      'settled',
      'RESOURCE_NOT_FOUND: Payment attempt "pa_missing" was not found',
    ],
  ])('exits 1 for %s and writes nothing', async (label, status, message) => {
    const { config, attempt, read } = await seeded();
    const io = createCapturingIo();
    const id = label === 'an unknown attempt' ? 'pa_missing' : attempt.id;

    const code = await runResolveCommand(id, { status, reason: 'x', actor: 'a' }, io, {
      loadConfig: async () => config,
    });

    expect(code).toBe(1);
    expect(io.err).toEqual([`FAIL  ${message}`]);
    expect((await read()).attempt?.resolution).toBeUndefined();
  });

  it('exits 1 without a flag hint for an attempt already resolved', async () => {
    const { config, attempt } = await seeded();
    const deps = { loadConfig: async () => config };
    await runResolveCommand(
      attempt.id,
      { status: 'settled', reason: 'x', actor: 'a' },
      createCapturingIo(),
      deps,
    );
    const io = createCapturingIo();

    expect(
      await runResolveCommand(attempt.id, { status: 'settled', reason: 'x', actor: 'b' }, io, deps),
    ).toBe(1);
    expect(io.err).toEqual([
      `FAIL  ${attempt.id} not resolved: The payment attempt already has a resolution [already_resolved, status=settled]`,
    ]);
  });

  it('exits 1 when the receipt database cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-resolve-'));
    tempDirs.push(dir);
    // A directory cannot be opened as a database file
    const config = makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path: dir } } });
    const io = createCapturingIo();

    expect(
      await runResolveCommand('pa_1', { status: 'settled', reason: 'x' }, io, {
        loadConfig: async () => config,
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain('FAIL  resolve could not run');
  });

  it('exits 1 with the config error', async () => {
    const io = createCapturingIo();
    const loadConfig = async () => {
      throw new CommerceError('CONFIG_INVALID', 'bad config', { details: { path: 'payments' } });
    };

    expect(
      await runResolveCommand('pa_1', { status: 'settled', reason: 'x' }, io, { loadConfig }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain('FAIL  CONFIG_INVALID: bad config');
  });
});

describe('AP2 holds from the CLI', () => {
  it('resolve consumes the hold in the AP2 replay database', async () => {
    const { config, attempt, read, mandateState } = await seeded({ ap2: true });
    const io = createCapturingIo();

    const code = await runResolveCommand(
      attempt.id,
      { status: 'settled', reason: 'found it', actor: 'a' },
      io,
      {
        loadConfig: async () => config,
      },
    );

    expect(code).toBe(0);
    expect(io.out).toEqual([`RESOLVED  ${attempt.id} status=settled`, 'HOLD      ap2 consumed']);
    expect(mandateState()).toBe('consumed');
    expect((await read()).hold).toBe('consumed');
  });

  it('resolve warns when AP2 is disabled and leaves the hold for reconcile', async () => {
    const seed = await seeded({ ap2: true });
    const config = { ...seed.config, authorization: undefined } as unknown as GatewayConfig;
    const io = createCapturingIo();

    const code = await runResolveCommand(
      seed.attempt.id,
      { status: 'settled', reason: 'x', actor: 'a' },
      io,
      {
        loadConfig: async () => config,
      },
    );

    expect(code).toBe(0);
    expect(io.out[1]).toBe(
      'WARN  ap2 hold not consumed (provider_not_enabled); agent-commerce reconcile aligns it once the provider is available',
    );
    expect(seed.mandateState()).toBe('uncertain');
    expect((await seed.read()).hold).toBe('uncertain');
  });

  it('reconcile aligns a hold left behind by an earlier resolution', async () => {
    const { config, attempt, read, mandateState } = await seeded({ ap2: true, settled: true });
    const io = createCapturingIo();

    const code = await runReconcileCommand({ actor: 'ops' }, io, {
      loadConfig: async () => config,
    });

    expect(code).toBe(0);
    expect(io.out).toEqual([
      'reconcile: 0 candidates, 0 settled, 0 not settled, 0 unknown, 0 resolved, 1 of 1 holds aligned',
      `HOLD        txn_1 attempt=${attempt.id} method=ap2 hold=consumed aligned`,
    ]);
    expect(mandateState()).toBe('consumed');
    expect((await read()).hold).toBe('consumed');
  });

  it('a reconcile dry run reports the hold and leaves both databases unchanged', async () => {
    const { config, attempt, read, mandateState } = await seeded({ ap2: true, settled: true });
    const io = createCapturingIo();

    await runReconcileCommand({ dryRun: true, json: true }, io, { loadConfig: async () => config });

    expect(JSON.parse(io.out.join('\n')).holds).toEqual([
      {
        transactionId: 'txn_1',
        attemptId: attempt.id,
        method: 'ap2',
        hold: 'consumed',
        written: false,
      },
    ]);
    expect(mandateState()).toBe('uncertain');
    expect((await read()).hold).toBe('uncertain');
  });
});
