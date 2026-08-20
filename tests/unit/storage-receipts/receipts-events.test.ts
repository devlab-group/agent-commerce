import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReceiptStore } from '../../../src/core/index.js';
import { createSqliteReceiptStore } from '../../../src/storage/receipts/index.js';
import { createFakeClock, createFakeIds, makeEvent, makeReceipt } from './helpers.js';

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

  it('honours the limit option', async () => {
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

    // Counting via listReceipts({ limit: 100_000 }) saturates: listReceipts
    // clamps to MAX_LIST_LIMIT (500), a store-level invariant, so such a count
    // would sit at 500 forever. countReceipts must stay exact past that clamp.
    it('counts exactly above the listReceipts clamp (500)', async () => {
      const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < 600; i++) {
        await store.saveReceipt(
          makeReceipt({ id: `r${i}`, deliveredAt: new Date(baseMs + i).toISOString() }),
        );
      }
      expect(await store.countReceipts()).toBe(600);
      // Confirms the two are genuinely independent, not the same code path.
      expect(await store.listReceipts()).toHaveLength(50); // DEFAULT_LIST_LIMIT
      expect(await store.listReceipts({ limit: 100_000 })).toHaveLength(500); // MAX_LIST_LIMIT
    });

    it('is unaffected by a requestId-scoped list — it always counts every receipt', async () => {
      await store.saveReceipt(makeReceipt({ id: 'ra', requestId: 'req_a' }));
      await store.saveReceipt(makeReceipt({ id: 'rb', requestId: 'req_b' }));
      const scoped = await store.listReceipts({ requestId: 'req_a' });
      expect(scoped).toHaveLength(1);
      expect(await store.countReceipts()).toBe(2);
    });
  });

  // doctor and the dashboard's receipt table must agree on what
  // "delivered" means (backendStatus outside 2xx),
  // otherwise a paid-but-undelivered purchase can go unnoticed by whichever
  // view someone happens to be looking at.
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

  it('round-trips optional fields (payment, protocol, metadata) exactly', async () => {
    const receipt = makeReceipt({
      id: 'r_full',
      protocol: 'http',
      metadata: { note: 'ok' },
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
    // Store is closed; the underlying prepared statement will throw. appendEvent
    // must swallow it rather than propagate.
    await expect(store.appendEvent(makeEvent({ id: 'after-close' }))).resolves.toBeUndefined();
  });
});

describe('list limit clamping', () => {
  // SQLite treats a negative LIMIT as "no limit" — measured:
  // `listReceipts({ limit: -1 })` against 120 rows returned all 120. Clamped
  // in the store (not only at the gateway route) so every caller is covered.
  const ROW_COUNT = 12;
  const MAX_LIST_LIMIT = 500;
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
  ] as const)(
    '%s: huge limit clamps to MAX_LIST_LIMIT, not the raw value',
    async (_name, getFn) => {
      const rows = await getFn()({ limit: 10_000_000 });
      expect(rows.length).toBe(ROW_COUNT); // fewer rows than the cap exist
      expect(rows.length).toBeLessThanOrEqual(MAX_LIST_LIMIT);
    },
  );

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
    expect(rows.length).toBe(Math.min(ROW_COUNT, DEFAULT_LIST_LIMIT));
  });

  // `protocols`' adversarial pass: NaN survives Math.trunc/max/min unclamped
  // and would reach `LIMIT ?` as-is. Not reachable through the gateway route
  // today (it filters non-finite values first), but the store must not rely
  // on that — it's a store-level invariant, not a caller's problem.
  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)(
    '%s: NaN limit falls back to the default, not an unbounded query',
    async (_name, getFn) => {
      const rows = await getFn()({ limit: Number.NaN });
      expect(rows.length).toBe(Math.min(ROW_COUNT, DEFAULT_LIST_LIMIT));
    },
  );

  it.each([
    ['listReceipts', () => store.listReceipts.bind(store)],
    ['listEvents', () => store.listEvents.bind(store)],
    ['listPaymentAttempts', () => store.listPaymentAttempts.bind(store)],
  ] as const)('%s: Infinity limit clamps to MAX_LIST_LIMIT', async (_name, getFn) => {
    const rows = await getFn()({ limit: Number.POSITIVE_INFINITY });
    expect(rows.length).toBe(ROW_COUNT);
    expect(rows.length).toBeLessThanOrEqual(MAX_LIST_LIMIT);
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

    // Noise from a different requestId must not leak into the correlated view.
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
