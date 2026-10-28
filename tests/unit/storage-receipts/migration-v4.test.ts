// Test schema-v4 upgrades with a fixed 2.4.1 SQL fixture and literal expected rows
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { createFakeClock, createFakeIds } from './helpers';

const FIXTURE = readFileSync(new URL('./fixtures/receipts-v3.sql', import.meta.url), 'utf8');

const RECEIPTS = [
  {
    id: 'receipt_failed',
    requestId: 'req_failed',
    resourceId: 'resource.report',
    deliveredAt: '2026-10-01T11:00:00.000Z',
    backendStatus: 502,
  },
  {
    id: 'receipt_paid',
    requestId: 'req_paid',
    resourceId: 'resource.report',
    deliveredAt: '2026-10-01T10:00:00.000Z',
    backendStatus: 200,
    payment: {
      status: 'settled',
      provider: 'x402',
      amount: '0.01',
      currency: 'USDC',
      externalReference: '0xsettled',
      network: 'eip155:31337',
    },
    durationMs: 12,
    protocol: 'mcp',
    metadata: { adapter: 'mcp' },
    authorization: { method: 'ap2', reference: 'sha256:mandate' },
  },
];

const EVENTS = [
  {
    id: 'event_settled',
    type: 'payment.settled',
    requestId: 'req_paid',
    at: '2026-10-01T10:00:00.000Z',
    resourceId: 'resource.report',
    adapter: 'mcp',
    paymentProvider: 'x402',
    durationMs: 5,
    status: 'ok',
    data: { externalReference: '0xsettled' },
  },
  {
    id: 'event_requested',
    type: 'resource.requested',
    requestId: 'req_paid',
    at: '2026-10-01T09:59:00.000Z',
  },
];

const attempt = (fields: Record<string, unknown>) => ({
  resourceId: 'resource.report',
  provider: 'x402',
  amount: '0.01',
  currency: 'USDC',
  ...fields,
});

const ATTEMPTS = [
  attempt({
    id: 'attempt_failed',
    requestId: 'req_legacy',
    replayKey: 'replay_failed',
    status: 'failed',
    createdAt: '2026-10-01T10:04:00.000Z',
    updatedAt: '2026-10-01T10:04:01.000Z',
  }),
  attempt({
    id: 'attempt_uncertain',
    requestId: 'req_uncertain',
    provider: 'mpp',
    replayKey: 'replay_uncertain',
    status: 'settlement-uncertain',
    externalReference: '0xpending',
    createdAt: '2026-10-01T10:03:00.000Z',
    updatedAt: '2026-10-01T10:03:01.000Z',
  }),
  attempt({
    id: 'attempt_rejected',
    requestId: 'req_rejected',
    replayKey: 'replay_rejected',
    status: 'rejected',
    rejectionReason: 'backend_failed',
    createdAt: '2026-10-01T10:02:00.000Z',
    updatedAt: '2026-10-01T10:02:01.000Z',
  }),
  attempt({
    id: 'attempt_reserved',
    requestId: 'req_reserved',
    replayKey: 'replay_reserved',
    status: 'reserved',
    createdAt: '2026-10-01T10:01:00.000Z',
    updatedAt: '2026-10-01T10:01:00.000Z',
  }),
  attempt({
    id: 'attempt_settled',
    requestId: 'req_paid',
    replayKey: 'replay_settled',
    status: 'settled',
    payer: '0xbuyer',
    payee: '0xmerchant',
    externalReference: '0xsettled',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:01.000Z',
  }),
];

describe('schema v4 migration', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-v4-'));
    path = join(dir, 'receipts.sqlite');
    const v3 = new Database(path);
    v3.exec(FIXTURE);
    v3.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const open = () =>
    createSqliteReceiptStore({ path, clock: createFakeClock(), ids: createFakeIds() });

  it('upgrades a 2.4.1 file to v4 and reads every row back unchanged, without transaction ids', async () => {
    const store = open();
    try {
      await store.init();

      expect(await store.listReceipts()).toStrictEqual(RECEIPTS);
      expect(await store.listEvents()).toStrictEqual(EVENTS);
      expect(await store.listPaymentAttempts()).toStrictEqual(ATTEMPTS);
      expect(await store.getPaymentAttempt?.('attempt_archived')).toStrictEqual(
        attempt({
          id: 'attempt_archived',
          requestId: 'req_first_try',
          replayKey: 'replay_rejected',
          status: 'rejected',
          rejectionReason: 'insufficient_funds',
          createdAt: '2026-10-01T09:00:00.000Z',
          updatedAt: '2026-10-01T09:00:01.000Z',
        }),
      );
      expect(await store.countReceipts()).toBe(2);
      expect(await store.countUndeliveredReceipts()).toBe(1);
      expect(await store.countUncertainPaymentAttempts()).toBe(2);
      // Migration leaves legacy rows without journal entries
      expect(await store.listTransactions?.()).toStrictEqual({ transactions: [] });
    } finally {
      await store.close();
    }
  });

  it('reports schema v4 in its descriptor and health', async () => {
    const store = open();
    try {
      await store.init();
      expect(store.descriptor.supportedSpec).toBe('sqlite-schema-v4');
      expect(store.descriptor.capabilities).toContain('transactions');
      expect(await store.health()).toMatchObject({
        status: 'pass',
        detail: 'sqlite schema v4 writable',
      });
    } finally {
      await store.close();
    }
  });

  it('keeps refusing the replay keys of migrated attempts', async () => {
    const store = open();
    try {
      for (const [replayKey, attemptStatus] of [
        ['replay_settled', 'settled'],
        ['replay_uncertain', 'settlement-uncertain'],
        ['replay_failed', 'failed'],
      ] as const) {
        await expect(
          store.reservePaymentAttempt({
            requestId: 'req_new',
            resourceId: 'resource.report',
            provider: 'x402',
            replayKey,
            amount: '0.01',
            currency: 'USDC',
            transaction: { id: 'txn_new', protocol: 'mcp', configDigest: 'sha256:terms' },
          }),
        ).rejects.toMatchObject({ code: 'PAYMENT_REPLAYED', details: { attemptStatus } });
      }
      expect(await store.getTransaction?.('txn_new')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('journals a purchase made after the upgrade', async () => {
    const store = open();
    try {
      const reserved = await store.reservePaymentAttempt({
        requestId: 'req_new',
        resourceId: 'resource.report',
        provider: 'x402',
        replayKey: 'replay_new',
        amount: '0.01',
        currency: 'USDC',
        transaction: { id: 'txn_new', protocol: 'mcp', configDigest: 'sha256:terms' },
      });
      expect(reserved.transactionId).toBe('txn_new');
      expect(await store.getTransaction?.('txn_new')).toMatchObject({
        state: 'payment-pending',
        payment: { attemptId: reserved.id, status: 'reserved' },
      });
    } finally {
      await store.close();
    }
  });

  it('leaves a v4 file unchanged when reopened', async () => {
    const schemaOf = () => {
      const db = new Database(path, { readonly: true });
      const result = {
        version: db.pragma('user_version', { simple: true }),
        sql: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(),
      };
      db.close();
      return result;
    };
    const first = open();
    await first.init();
    await first.reservePaymentAttempt({
      requestId: 'req_new',
      resourceId: 'resource.report',
      provider: 'x402',
      replayKey: 'replay_new',
      amount: '0.01',
      currency: 'USDC',
      transaction: { id: 'txn_new', protocol: 'mcp', configDigest: 'sha256:terms' },
    });
    const transaction = await first.getTransaction?.('txn_new');
    await first.close();
    const before = schemaOf();

    const second = open();
    try {
      await second.init();
      expect(schemaOf()).toStrictEqual(before);
      expect(before.version).toBe(4);
      expect(await second.getTransaction?.('txn_new')).toStrictEqual(transaction);
      expect(await second.listReceipts()).toStrictEqual(RECEIPTS);
    } finally {
      await second.close();
    }
  });
});
