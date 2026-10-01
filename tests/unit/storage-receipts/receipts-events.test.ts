import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReceiptStore } from '../../../src/core';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { createFakeClock, createFakeIds, makeEvent, makeReceipt } from './helpers';

describe('receipts', () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('saves and retrieves a receipt by id', async () => {
    const receipt = makeReceipt({
      id: 'r1',
      resourceId: 'resource.report',
      backendStatus: 200,
      durationMs: 42,
    });
    await store.saveReceipt(receipt);

    const fetched = await store.getReceipt('r1');
    expect(fetched).toEqual(receipt);
  });

  it('returns undefined for a missing receipt', async () => {
    expect(await store.getReceipt('does-not-exist')).toBeUndefined();
  });

  it('lists receipts newest-first', async () => {
    await store.saveReceipt(makeReceipt({ id: 'r1', deliveredAt: '2026-01-01T00:00:00.000Z' }));
    await store.saveReceipt(makeReceipt({ id: 'r2', deliveredAt: '2026-01-01T00:00:01.000Z' }));
    await store.saveReceipt(makeReceipt({ id: 'r3', deliveredAt: '2026-01-01T00:00:02.000Z' }));

    const listed = await store.listReceipts();
    expect(listed.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('honors the limit option', async () => {
    await store.saveReceipt(makeReceipt({ id: 'r1', deliveredAt: '2026-01-01T00:00:00.000Z' }));
    await store.saveReceipt(makeReceipt({ id: 'r2', deliveredAt: '2026-01-01T00:00:01.000Z' }));
    await store.saveReceipt(makeReceipt({ id: 'r3', deliveredAt: '2026-01-01T00:00:02.000Z' }));

    const listed = await store.listReceipts({ limit: 2 });
    expect(listed).toHaveLength(2);
    expect(listed.map((r) => r.id)).toEqual(['r3', 'r2']);
  });

  describe('countReceipts', () => {
    it('is zero on an empty store', async () => {
      expect(await store.countReceipts()).toBe(0);
    });

    // listReceipts clamps to MAX_LIST_LIMIT (500), so a count taken from it
    // stops at 500. countReceipts stays exact past the clamp.
    it('counts exactly above the listReceipts clamp (500)', async () => {
      const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < 600; i++) {
        await store.saveReceipt(
          makeReceipt({ id: `r${i}`, deliveredAt: new Date(baseMs + i).toISOString() }),
        );
      }
      expect(await store.countReceipts()).toBe(600);
      // The list stays clamped, so the count does not come from it
      expect(await store.listReceipts()).toHaveLength(50); // DEFAULT_LIST_LIMIT
      expect(await store.listReceipts({ limit: 100_000 })).toHaveLength(500); // MAX_LIST_LIMIT
    });

    it('is unaffected by a requestId-scoped list and always counts every receipt', async () => {
      await store.saveReceipt(makeReceipt({ id: 'ra', requestId: 'req_a' }));
      await store.saveReceipt(makeReceipt({ id: 'rb', requestId: 'req_b' }));
      const scoped = await store.listReceipts({ requestId: 'req_a' });
      expect(scoped).toHaveLength(1);
      expect(await store.countReceipts()).toBe(2);
    });
  });

  // doctor and the dashboard's receipt table must share one rule for
  // undelivered (backendStatus outside 2xx), or a paid-but-undelivered
  // purchase goes unnoticed in one of them
  describe('countUndeliveredReceipts', () => {
    it('is zero on an empty store', async () => {
      expect(await store.countUndeliveredReceipts()).toBe(0);
    });

    it('counts non-2xx receipts, including 0 (backend never responded)', async () => {
      await store.saveReceipt(makeReceipt({ id: 'ok1', backendStatus: 200 }));
      await store.saveReceipt(makeReceipt({ id: 'ok2', backendStatus: 299 }));
      await store.saveReceipt(makeReceipt({ id: 'bad1', backendStatus: 500 }));
      await store.saveReceipt(makeReceipt({ id: 'bad2', backendStatus: 199 }));
      await store.saveReceipt(makeReceipt({ id: 'bad3', backendStatus: 300 }));
      await store.saveReceipt(makeReceipt({ id: 'bad4', backendStatus: 0 }));

      expect(await store.countUndeliveredReceipts()).toBe(4);
      expect(await store.countReceipts()).toBe(6); // independent of the undelivered count
    });

    it('counts exactly above the listReceipts clamp (500), same discipline as countReceipts', async () => {
      const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < 600; i++) {
        await store.saveReceipt(
          makeReceipt({
            id: `u${i}`,
            deliveredAt: new Date(baseMs + i).toISOString(),
            backendStatus: 500,
          }),
        );
      }
      expect(await store.countUndeliveredReceipts()).toBe(600);
    });
  });

  it('round-trips optional fields (payment, protocol, metadata, authorization) exactly', async () => {
    const receipt = makeReceipt({
      id: 'r_full',
      protocol: 'http',
      metadata: { note: 'ok' },
      authorization: {
        method: 'ap2',
        reference: 'sha256:abc',
        // Not `checkoutJwtId`: the redactor replaces the value of any key containing "jwt"
        metadata: { checkoutId: 'checkout-1' },
      },
      payment: {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        externalReference: '0xabc',
        payer: '0xbuyer',
        payee: '0xmerchant',
      },
    });
    await store.saveReceipt(receipt);
    expect(await store.getReceipt('r_full')).toEqual(receipt);
  });

  it('omits optional fields entirely when not present, rather than storing undefined/null', async () => {
    const receipt = makeReceipt({ id: 'r_minimal' });
    await store.saveReceipt(receipt);
    const fetched = await store.getReceipt('r_minimal');
    expect(fetched).toBeDefined();
    expect('payment' in (fetched ?? {})).toBe(false);
    expect('durationMs' in (fetched ?? {})).toBe(false);
    expect('protocol' in (fetched ?? {})).toBe(false);
    expect('metadata' in (fetched ?? {})).toBe(false);
    expect('authorization' in (fetched ?? {})).toBe(false);
  });
});

describe('events', () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('appends and lists events newest-first', async () => {
    await store.appendEvent(
      makeEvent({ id: 'e1', at: '2026-01-01T00:00:00.000Z', type: 'resource.requested' }),
    );
    await store.appendEvent(
      makeEvent({ id: 'e2', at: '2026-01-01T00:00:01.000Z', type: 'resource.delivered' }),
    );

    const listed = await store.listEvents();
    expect(listed.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('round-trips optional fields', async () => {
    const event = makeEvent({
      id: 'e_full',
      resourceId: 'resource.report',
      adapter: 'mcp',
      paymentProvider: 'x402',
      durationMs: 12,
      status: 'ok',
      data: { httpStatus: 200 },
    });
    await store.appendEvent(event);
    const [fetched] = await store.listEvents({ requestId: event.requestId });
    expect(fetched).toEqual(event);
  });

  it('never throws into the caller on a persistence failure', async () => {
    await store.close();
    // The store is closed, so the insert throws; appendEvent swallows it
    await expect(store.appendEvent(makeEvent({ id: 'after-close' }))).resolves.toBeUndefined();
  });
});

describe('list limit clamping', () => {
  // SQLite reads a negative LIMIT as no limit, so without the store's clamp
  // `listReceipts({ limit: -1 })` returns every row. One row more than the
  // default page, so a fallback to the default is visible.
  const ROW_COUNT = 51;
  const DEFAULT_LIST_LIMIT = 50;

  let store: ReceiptStore;

  beforeEach(async () => {
    store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();
    for (let i = 0; i < ROW_COUNT; i++) {
      await store.saveReceipt(makeReceipt({ id: `r${i}` }));
      await store.appendEvent(makeEvent({ id: `e${i}` }));
      await store.reservePaymentAttempt({
        requestId: `req_${i}`,
        resourceId: 'resource.report',
        provider: 'x402',
        replayKey: `replay_${i}`,
        amount: '0.01',
        currency: 'USDC',
      });
    }
  });

  afterEach(async () => {
    await store.close();
  });

  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)('%s: negative limit does not return the whole table', async (_name, getFn) => {
    const rows = await getFn()({ limit: -1 });
    expect(rows.length).toBe(1);
  });

  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)('%s: zero limit clamps to 1', async (_name, getFn) => {
    const rows = await getFn()({ limit: 0 });
    expect(rows.length).toBe(1);
  });

  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)('%s: huge limit returns every row below the cap', async (_name, getFn) => {
    // The cap itself is asserted with 600 rows in the countReceipts tests
    const rows = await getFn()({ limit: 10_000_000 });
    expect(rows.length).toBe(ROW_COUNT);
  });

  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)('%s: fractional limit truncates', async (_name, getFn) => {
    const rows = await getFn()({ limit: 3.9 });
    expect(rows.length).toBe(3);
  });

  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)('%s: undefined limit falls back to the default', async (_name, getFn) => {
    const rows = await getFn()({});
    expect(rows.length).toBe(DEFAULT_LIST_LIMIT);
  });

  // NaN survives Math.trunc/max/min and would reach `LIMIT ?` as-is. The
  // gateway route already drops a non-finite limit, but the store must not
  // rely on its callers.
  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)(
    '%s: NaN limit falls back to the default, not an unbounded query',
    async (_name, getFn) => {
      const rows = await getFn()({ limit: Number.NaN });
      expect(rows.length).toBe(DEFAULT_LIST_LIMIT);
    },
  );

  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)('%s: Infinity limit falls back to the default', async (_name, getFn) => {
    const rows = await getFn()({ limit: Number.POSITIVE_INFINITY });
    expect(rows.length).toBe(DEFAULT_LIST_LIMIT);
  });
});

describe('correlation by requestId', () => {
  it('correlates receipts, events and payment attempts sharing one requestId', async () => {
    const store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();

    const requestId = 'req_shared';
    await store.saveReceipt(makeReceipt({ id: 'r_shared', requestId }));
    await store.appendEvent(makeEvent({ id: 'e_shared', requestId, type: 'resource.delivered' }));
    await store.reservePaymentAttempt({
      requestId,
      resourceId: 'resource.report',
      provider: 'x402',
      replayKey: 'replay_shared',
      amount: '0.01',
      currency: 'USDC',
    });

    // Rows of another requestId stay out of the filtered lists
    await store.saveReceipt(makeReceipt({ id: 'r_other', requestId: 'req_other' }));
    await store.appendEvent(makeEvent({ id: 'e_other', requestId: 'req_other' }));
    await store.reservePaymentAttempt({
      requestId: 'req_other',
      resourceId: 'resource.report',
      provider: 'x402',
      replayKey: 'replay_other',
      amount: '0.01',
      currency: 'USDC',
    });

    const receipts = await store.listReceipts({ requestId });
    const events = await store.listEvents({ requestId });
    const attempts = await store.listPaymentAttempts({ requestId });

    expect(receipts.map((r) => r.id)).toEqual(['r_shared']);
    expect(events.map((e) => e.id)).toEqual(['e_shared']);
    expect(attempts.map((a) => a.replayKey)).toEqual(['replay_shared']);

    await store.close();
  });
});
