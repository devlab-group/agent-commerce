// Conformance cases for the 2.5 surface: receipts, events, payment attempts,
// reclaim and the journal
import assert from 'node:assert/strict';
import {
  type CommerceEvent,
  type CommerceReceipt,
  type IsoTimestamp,
  type NewTransaction,
  type PaymentAttempt,
  type PaymentAttemptReservation,
  type PaymentAttemptResolution,
  type PaymentAttemptResolveRequest,
  type ReceiptStore,
  type Transaction,
  type TransactionFacts,
  type TransactionListOptions,
  type TransactionPage,
  type TransactionStep,
  transactionState,
} from '../../core';
import { type CaseSpec, isoAt, rejectsWithCode } from './support';

// Exercise reservation and resolution races with several concurrent callers
const RACERS = 8;
const MAX_PAGES = 50;

type AttemptStatus = PaymentAttempt['status'];

const ALL_STATUSES: readonly AttemptStatus[] = [
  'reserved',
  'verified',
  'settled',
  'rejected',
  'failed',
  'settlement-uncertain',
];

// --- builders ---------------------------------------------------------------

function receipt(id: string, overrides: Partial<CommerceReceipt> = {}): CommerceReceipt {
  return {
    id,
    requestId: 'req_1',
    resourceId: 'resource.report',
    deliveredAt: isoAt(0),
    backendStatus: 200,
    ...overrides,
  };
}

function event(id: string, overrides: Partial<CommerceEvent> = {}): CommerceEvent {
  return { id, type: 'resource.requested', requestId: 'req_1', at: isoAt(0), ...overrides };
}

function reservation(
  n: number,
  overrides: Partial<PaymentAttemptReservation> = {},
): PaymentAttemptReservation {
  return {
    requestId: `req_${n}`,
    resourceId: 'resource.report',
    provider: 'x402',
    replayKey: `replay_${n}`,
    amount: '0.01',
    currency: 'USDC',
    ...overrides,
  };
}

// A reservation that also opens a journal row
function journaled(
  n: number,
  transaction: Partial<NewTransaction> = {},
  overrides: Partial<PaymentAttemptReservation> = {},
): PaymentAttemptReservation {
  return reservation(n, {
    transaction: { id: `txn_${n}`, protocol: 'mcp', configDigest: 'sha256:terms', ...transaction },
    ...overrides,
  });
}

function hold(n: number): NonNullable<NewTransaction['authorization']> {
  return {
    method: 'ap2',
    reference: `sha256:mandate_${n}`,
    metadata: { issuer: 'did:web:agent.example' },
    reservationId: `sha256:mandate_${n}`,
  };
}

// Optional stored fields for a reservation and its journal row
function fullJournaled(n: number): PaymentAttemptReservation {
  return journaled(
    n,
    {
      network: 'eip155:31337',
      asset: '0xasset',
      locator: { v: 1, nonce: '0xnonce' },
      expiresAt: isoAt(300_000),
      authorization: hold(n),
      inputDigest: 'sha256:input',
    },
    { payer: '0xbuyer', payee: '0xmerchant' },
  );
}

function factsOf(
  status: AttemptStatus,
  extra: Omit<TransactionFacts, 'payment'> = {},
): TransactionFacts {
  return { payment: { status }, ...extra };
}

const FULL_RECEIPT: CommerceReceipt = {
  id: 'receipt_full',
  requestId: 'req_full',
  transactionId: 'txn_full',
  resourceId: 'resource.report',
  payment: {
    status: 'settled',
    provider: 'x402',
    externalReference: '0xabc',
    payer: '0xbuyer',
    payee: '0xmerchant',
    amount: '0.01',
    currency: 'USDC',
    network: 'eip155:31337',
    asset: '0xasset',
    replayKey: 'replay_full',
    settledAt: isoAt(500),
    metadata: { flow: 'authorization' },
  },
  authorization: {
    method: 'ap2',
    reference: 'sha256:mandate',
    metadata: { checkoutId: 'checkout-1' },
  },
  deliveredAt: isoAt(1000),
  backendStatus: 200,
  durationMs: 42,
  protocol: 'http',
  metadata: { note: 'ok' },
};

const FULL_EVENT: CommerceEvent = {
  id: 'event_full',
  type: 'payment.settled',
  requestId: 'req_full',
  transactionId: 'txn_full',
  resourceId: 'resource.report',
  at: isoAt(0),
  adapter: 'mcp',
  paymentProvider: 'x402',
  durationMs: 12,
  status: 'ok',
  data: { httpStatus: 200 },
};

const RESOLUTION: PaymentAttemptResolution = {
  method: 'reconcile',
  actor: 'agent-commerce reconcile',
  reason: 'transfer_found',
  at: isoAt(5000),
  externalReference: '0xlanded',
  evidence: { blockNumber: 12 },
};

// --- helpers ----------------------------------------------------------------

function defined<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} was not found`);
  return value;
}

function only<T>(items: readonly T[], what: string): T {
  assert.equal(items.length, 1, what);
  return defined(items[0], what);
}

const ids = (items: readonly { readonly id: string }[]): string[] => items.map((item) => item.id);

// A store may ignore the `undelivered` and `uncertain` list flags and return
// the unfiltered list; any other answer must be exactly the filtered one
function assertFiltered<T>(
  actual: readonly T[],
  filtered: readonly T[],
  unfiltered: readonly T[],
): void {
  try {
    assert.deepEqual(actual, unfiltered);
  } catch {
    assert.deepEqual(actual, filtered);
  }
}

function assertIso(value: string): void {
  assert.equal(new Date(value).toISOString(), value);
}

async function attemptFor(store: ReceiptStore, replayKey: string): Promise<PaymentAttempt> {
  const attempts = (await store.listPaymentAttempts()).filter((a) => a.replayKey === replayKey);
  return only(attempts, `attempts for ${replayKey}`);
}

async function moveTo(
  store: ReceiptStore,
  replayKey: string,
  status: AttemptStatus,
  rest: { readonly externalReference?: string; readonly rejectionReason?: string } = {},
): Promise<void> {
  if (status !== 'reserved') await store.updatePaymentAttempt({ replayKey, status, ...rest });
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

// `details.attemptStatus` is documented as present "when available"
function reportedStatus(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('details' in error)) return undefined;
  const { details } = error;
  return typeof details === 'object' && details !== null && 'attemptStatus' in details
    ? details.attemptStatus
    : undefined;
}

// An absent status passes; a wrong one does not
function assertReportedStatus(error: unknown, holder: AttemptStatus): void {
  const reported = reportedStatus(error);
  if (reported !== undefined) assert.equal(reported, holder);
}

async function expectReplayed(call: Promise<unknown>, holder: AttemptStatus): Promise<void> {
  assertReportedStatus(await rejectsWithCode(call, 'PAYMENT_REPLAYED'), holder);
}

interface Settled<T> {
  readonly won: readonly T[];
  readonly lost: readonly unknown[];
}

async function settle<T>(calls: readonly Promise<T>[]): Promise<Settled<T>> {
  const won: T[] = [];
  const lost: unknown[] = [];
  for (const result of await Promise.allSettled(calls)) {
    if (result.status === 'fulfilled') won.push(result.value);
    else lost.push(result.reason);
  }
  return { won, lost };
}

// Exactly one caller may hold the key; the rest are refused as replays of the winner
function soleWinner<T>(outcome: Settled<T>): T {
  assert.equal(outcome.won.length, 1, 'exactly one reservation must succeed');
  assert.equal(outcome.lost.length, RACERS - 1);
  for (const error of outcome.lost) {
    assert.equal(codeOf(error), 'PAYMENT_REPLAYED');
    assertReportedStatus(error, 'reserved');
  }
  return defined(outcome.won[0], 'the winning reservation');
}

interface Journal {
  record(step: TransactionStep): Promise<void>;
  get(id: string): Promise<Transaction | undefined>;
  list(options?: TransactionListOptions): Promise<TransactionPage>;
  attempt(id: string): Promise<PaymentAttempt | undefined>;
  resolve(request: PaymentAttemptResolveRequest): Promise<boolean>;
}

// Assert that the optional journal methods a case calls are available
function journalOf(store: ReceiptStore): Journal {
  const unsupported = (name: string): never => assert.fail(`the store does not implement ${name}`);
  return {
    record: (step) => store.recordTransactionStep?.(step) ?? unsupported('recordTransactionStep'),
    get: (id) => store.getTransaction?.(id) ?? unsupported('getTransaction'),
    list: (options) => store.listTransactions?.(options) ?? unsupported('listTransactions'),
    attempt: (id) => store.getPaymentAttempt?.(id) ?? unsupported('getPaymentAttempt'),
    resolve: (request) =>
      store.resolvePaymentAttempt?.(request) ?? unsupported('resolvePaymentAttempt'),
  };
}

async function transactionOf(journal: Journal, id: string): Promise<Transaction> {
  return defined(await journal.get(id), `transaction ${id}`);
}

async function attemptById(journal: Journal, id: string): Promise<PaymentAttempt> {
  return defined(await journal.attempt(id), `payment attempt ${id}`);
}

// The cached state and a reader's own derivation from the stored facts must agree
function assertState(tx: Transaction, facts: TransactionFacts, now: IsoTimestamp): void {
  const expected = transactionState(facts, now);
  assert.equal(tx.state, expected);
  assert.equal(transactionState(tx, now), expected);
}

// Follow `nextCursor` to its end, as the contract says a caller must
async function walk(
  journal: Journal,
  options: TransactionListOptions = {},
): Promise<readonly TransactionPage[]> {
  const pages: TransactionPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await journal.list({ ...options, ...(cursor !== undefined ? { cursor } : {}) });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages.length < MAX_PAGES);
  assert.equal(cursor, undefined, 'pagination did not end');
  return pages;
}

async function listAll(journal: Journal, options: TransactionListOptions = {}): Promise<string[]> {
  return (await walk(journal, options)).flatMap((page) => ids(page.transactions));
}

// A payment attempt held in `settlement-uncertain`, with its journal row
async function uncertain(store: ReceiptStore, n: number): Promise<PaymentAttempt> {
  const attempt = await store.reservePaymentAttempt(journaled(n));
  await store.updatePaymentAttempt({
    replayKey: attempt.replayKey,
    status: 'settlement-uncertain',
    externalReference: '0xpending',
  });
  return attempt;
}

// --- receipts ---------------------------------------------------------------

const RECEIPT_CASES: readonly CaseSpec[] = [
  {
    name: 'a receipt reads back with every field it was saved with',
    async run({ store }) {
      await store.saveReceipt(FULL_RECEIPT);
      assert.deepEqual(await store.getReceipt(FULL_RECEIPT.id), FULL_RECEIPT);
      assert.deepEqual(await store.listReceipts(), [FULL_RECEIPT]);
    },
  },
  {
    name: 'a receipt saved with only its required fields reads back without optional ones',
    async run({ store }) {
      const minimal = receipt('receipt_min');
      await store.saveReceipt(minimal);
      assert.deepEqual(await store.getReceipt(minimal.id), minimal);
    },
  },
  {
    name: 'a receipt id nobody saved reads back as undefined',
    async run({ store }) {
      assert.equal(await store.getReceipt('receipt_missing'), undefined);
      await store.saveReceipt(receipt('receipt_1'));
      assert.equal(await store.getReceipt('receipt_missing'), undefined);
    },
  },
  {
    name: 'receipts list newest first and honor the limit',
    async run({ store, clock }) {
      for (const id of ['r1', 'r2', 'r3']) {
        await store.saveReceipt(receipt(id, { deliveredAt: clock.nowIso() }));
        clock.advance(1000);
      }
      assert.deepEqual(ids(await store.listReceipts()), ['r3', 'r2', 'r1']);
      assert.deepEqual(ids(await store.listReceipts({ limit: 2 })), ['r3', 'r2']);
    },
  },
  {
    name: 'receipts filter by request id',
    async run({ store, clock }) {
      for (const [id, requestId] of [
        ['r1', 'req_a'],
        ['r2', 'req_b'],
        ['r3', 'req_a'],
      ] as const) {
        await store.saveReceipt(receipt(id, { requestId, deliveredAt: clock.nowIso() }));
        clock.advance(1000);
      }
      assert.deepEqual(ids(await store.listReceipts({ requestId: 'req_a' })), ['r3', 'r1']);
      assert.deepEqual(await store.listReceipts({ requestId: 'req_unknown' }), []);
    },
  },
  {
    name: 'the undelivered flag selects exactly the receipts outside 2xx, status 0 included',
    async run({ store, clock }) {
      const saved = [
        ['ok_200', 200, 'req_a'],
        ['bad_0', 0, 'req_b'],
        ['ok_204', 204, 'req_b'],
        ['bad_199', 199, 'req_a'],
        ['ok_299', 299, 'req_a'],
        ['bad_300', 300, 'req_b'],
        ['bad_404', 404, 'req_a'],
        ['bad_500', 500, 'req_b'],
      ] as const;
      for (const [id, backendStatus, requestId] of saved) {
        await store.saveReceipt(
          receipt(id, { requestId, backendStatus, deliveredAt: clock.nowIso() }),
        );
        clock.advance(1000);
      }

      const all = ids(await store.listReceipts());
      assert.equal(all.length, saved.length);
      assertFiltered(
        ids(await store.listReceipts({ undelivered: true })),
        ['bad_500', 'bad_404', 'bad_300', 'bad_199', 'bad_0'],
        all,
      );
      // Both filters together keep only the receipts that satisfy each
      assertFiltered(
        ids(await store.listReceipts({ requestId: 'req_a', undelivered: true })),
        ['bad_404', 'bad_199'],
        ids(await store.listReceipts({ requestId: 'req_a' })),
      );
    },
  },
  {
    name: 'receipt counts match what was saved',
    async run({ store, clock }) {
      assert.equal(await store.countReceipts(), 0);
      assert.equal(await store.countUndeliveredReceipts(), 0);

      for (const [id, backendStatus] of [
        ['r1', 200],
        ['r2', 500],
        ['r3', 0],
      ] as const) {
        await store.saveReceipt(receipt(id, { backendStatus, deliveredAt: clock.nowIso() }));
        clock.advance(1000);
      }
      assert.equal(await store.countReceipts(), 3);
      assert.equal(await store.countUndeliveredReceipts(), 2);

      await store.saveReceipt(receipt('r4', { backendStatus: 204, deliveredAt: clock.nowIso() }));
      assert.equal(await store.countReceipts(), 4);
      assert.equal(await store.countUndeliveredReceipts(), 2);
    },
  },
];

// --- events -----------------------------------------------------------------

const EVENT_CASES: readonly CaseSpec[] = [
  {
    name: 'an event reads back with every field it was appended with',
    async run({ store }) {
      await store.appendEvent(FULL_EVENT);
      assert.deepEqual(await store.listEvents(), [FULL_EVENT]);
    },
  },
  {
    name: 'an event appended with only its required fields reads back without optional ones',
    async run({ store }) {
      const minimal = event('event_min');
      await store.appendEvent(minimal);
      assert.deepEqual(await store.listEvents(), [minimal]);
    },
  },
  {
    name: 'events list newest first',
    async run({ store, clock }) {
      for (const id of ['e1', 'e2', 'e3']) {
        await store.appendEvent(event(id, { at: clock.nowIso() }));
        clock.advance(1000);
      }
      assert.deepEqual(ids(await store.listEvents()), ['e3', 'e2', 'e1']);
    },
  },
  {
    name: 'events filter by request id',
    async run({ store, clock }) {
      for (const [id, requestId] of [
        ['e1', 'req_a'],
        ['e2', 'req_b'],
        ['e3', 'req_a'],
      ] as const) {
        await store.appendEvent(event(id, { requestId, at: clock.nowIso() }));
        clock.advance(1000);
      }
      assert.deepEqual(ids(await store.listEvents({ requestId: 'req_a' })), ['e3', 'e1']);
      assert.deepEqual(await store.listEvents({ requestId: 'req_unknown' }), []);
    },
  },
  {
    name: 'appending an event whose id was already used does not reject',
    async run({ store, clock }) {
      await store.appendEvent(event('event_1'));
      // The store may keep both or drop the second; either way the caller's flow goes on
      await store.appendEvent(event('event_1', { type: 'resource.delivered' }));

      clock.advance(1000);
      await store.appendEvent(event('event_2', { at: clock.nowIso() }));
      const listed = ids(await store.listEvents());
      assert.ok(listed.includes('event_1'));
      assert.ok(listed.includes('event_2'));
    },
  },
];

// --- payment attempts -------------------------------------------------------

const ATTEMPT_CASES: readonly CaseSpec[] = [
  {
    name: 'a reservation returns a reserved attempt carrying the reservation fields',
    async run({ store }) {
      const withParties = await store.reservePaymentAttempt(
        reservation(1, { payer: '0xbuyer', payee: '0xmerchant' }),
      );
      assert.ok(withParties.id !== '');
      assertIso(withParties.createdAt);
      assertIso(withParties.updatedAt);
      assert.deepEqual(withParties, {
        id: withParties.id,
        requestId: 'req_1',
        resourceId: 'resource.report',
        provider: 'x402',
        replayKey: 'replay_1',
        status: 'reserved',
        amount: '0.01',
        currency: 'USDC',
        payer: '0xbuyer',
        payee: '0xmerchant',
        createdAt: withParties.createdAt,
        updatedAt: withParties.updatedAt,
      });

      // Optional fields the reservation leaves out stay out of the attempt
      const bare = await store.reservePaymentAttempt(reservation(2));
      assert.deepEqual(bare, {
        id: bare.id,
        requestId: 'req_2',
        resourceId: 'resource.report',
        provider: 'x402',
        replayKey: 'replay_2',
        status: 'reserved',
        amount: '0.01',
        currency: 'USDC',
        createdAt: bare.createdAt,
        updatedAt: bare.updatedAt,
      });
      assert.notEqual(bare.id, withParties.id);

      assert.deepEqual(await attemptFor(store, 'replay_1'), withParties);
      assert.deepEqual(await attemptFor(store, 'replay_2'), bare);
    },
  },
  {
    name: 'payment attempts filter by request id',
    async run({ store, clock }) {
      for (const [n, requestId] of [
        [1, 'req_a'],
        [2, 'req_b'],
        [3, 'req_a'],
      ] as const) {
        await store.reservePaymentAttempt(reservation(n, { requestId }));
        clock.advance(1000);
      }
      const listed = await store.listPaymentAttempts({ requestId: 'req_a' });
      assert.deepEqual(listed.map((a) => a.replayKey).sort(), ['replay_1', 'replay_3']);
      assert.deepEqual(await store.listPaymentAttempts({ requestId: 'req_unknown' }), []);
    },
  },
  {
    name: 'an update changes the status of the attempt it names and nothing else',
    async run({ store, clock }) {
      const reserved = await store.reservePaymentAttempt(reservation(1));
      await store.reservePaymentAttempt(reservation(2));

      clock.advance(1000);
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'verified' });
      const verified = await attemptFor(store, 'replay_1');
      assert.equal(verified.status, 'verified');
      assert.deepEqual(
        { ...verified, status: 'reserved', updatedAt: reserved.updatedAt },
        reserved,
      );

      await store.updatePaymentAttempt({
        replayKey: 'replay_1',
        status: 'settled',
        externalReference: '0xtx',
      });
      const settled = await attemptFor(store, 'replay_1');
      assert.equal(settled.status, 'settled');
      assert.equal(settled.externalReference, '0xtx');

      assert.equal((await attemptFor(store, 'replay_2')).status, 'reserved');
      await store.updatePaymentAttempt({
        replayKey: 'replay_2',
        status: 'rejected',
        rejectionReason: 'wrong_amount',
      });
      const rejected = await attemptFor(store, 'replay_2');
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.rejectionReason, 'wrong_amount');
      assert.deepEqual(await attemptFor(store, 'replay_1'), settled);
    },
  },
  {
    name: 'an update that omits externalReference keeps the one already stored',
    async run({ store }) {
      await store.reservePaymentAttempt(reservation(1));
      await store.updatePaymentAttempt({
        replayKey: 'replay_1',
        status: 'settlement-uncertain',
        externalReference: '0xbroadcast',
      });

      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settled' });

      const attempt = await attemptFor(store, 'replay_1');
      assert.equal(attempt.status, 'settled');
      assert.equal(attempt.externalReference, '0xbroadcast');
    },
  },
  {
    name: 'uncertain attempts are listed and counted: settlement-uncertain and legacy failed only',
    async run({ store, clock }) {
      assert.equal(await store.countUncertainPaymentAttempts(), 0);
      assert.deepEqual(await store.listPaymentAttempts({ uncertain: true }), []);

      for (const [index, status] of ALL_STATUSES.entries()) {
        const n = index + 1;
        await store.reservePaymentAttempt(reservation(n, { requestId: `req_${status}` }));
        await moveTo(store, `replay_${n}`, status, {
          ...(status === 'settlement-uncertain' ? { externalReference: '0xhash' } : {}),
        });
        clock.advance(1000);
      }
      // A second uncertain attempt of a request that already has one
      await store.reservePaymentAttempt(reservation(7, { requestId: 'req_failed' }));
      await moveTo(store, 'replay_7', 'settlement-uncertain');

      assert.equal(await store.countUncertainPaymentAttempts(), 3);
      const keys = (attempts: readonly PaymentAttempt[]) => attempts.map((a) => a.replayKey).sort();
      const listed = await store.listPaymentAttempts({ uncertain: true });
      assert.equal((await store.listPaymentAttempts()).length, 7);
      assertFiltered(
        keys(listed),
        ['replay_5', 'replay_6', 'replay_7'],
        keys(await store.listPaymentAttempts()),
      );
      // Preserve the recorded broadcast hash for operator reconciliation
      assert.equal(listed.find((a) => a.replayKey === 'replay_6')?.externalReference, '0xhash');

      for (const [requestId, expected] of [
        ['req_failed', ['replay_5', 'replay_7']],
        ['req_settled', []],
      ] as const) {
        assertFiltered(
          keys(await store.listPaymentAttempts({ requestId, uncertain: true })),
          expected,
          keys(await store.listPaymentAttempts({ requestId })),
        );
      }
    },
  },
];

// --- replay and races -------------------------------------------------------

const REPLAY_CASES: readonly CaseSpec[] = [
  {
    name: 'a second reservation of a replay key is refused',
    async run({ store }) {
      const first = await store.reservePaymentAttempt(reservation(1, { payer: '0xfirst' }));

      // The replay key comes from the authorization, so no other field can make it new
      for (const second of [
        reservation(1),
        reservation(2, { replayKey: 'replay_1', payer: '0xsecond' }),
        reservation(3, { replayKey: 'replay_1', provider: 'mpp', resourceId: 'resource.other' }),
      ]) {
        await expectReplayed(store.reservePaymentAttempt(second), 'reserved');
      }
      assert.deepEqual(await store.listPaymentAttempts(), [first]);
    },
  },
  {
    name: 'a refused reservation reports the status of the attempt that holds the key',
    async run({ store }) {
      for (const [index, status] of ALL_STATUSES.entries()) {
        const n = index + 1;
        await store.reservePaymentAttempt(reservation(n));
        await moveTo(store, `replay_${n}`, status);

        await expectReplayed(
          store.reservePaymentAttempt(reservation(n + 10, { replayKey: `replay_${n}` })),
          status,
        );
      }
    },
  },
  {
    name: 'concurrent reservations of one replay key let exactly one win',
    async run({ store }) {
      const calls = Array.from({ length: RACERS }, (_, i) =>
        store.reservePaymentAttempt(reservation(i, { replayKey: 'replay_race' })),
      );

      const winner = soleWinner(await settle(calls));

      assert.equal(winner.status, 'reserved');
      assert.deepEqual(await store.listPaymentAttempts(), [winner]);
    },
  },
];

// --- reclaim ----------------------------------------------------------------

const RECLAIM_CASES: readonly CaseSpec[] = [
  {
    name: 'with reclaimRejected the same provider replaces its own rejected attempt',
    async run({ store, clock }) {
      await store.reservePaymentAttempt(reservation(1, { payer: '0xfirst' }));
      await moveTo(store, 'replay_1', 'rejected', {
        rejectionReason: 'backend_failed',
        externalReference: '0xnever',
      });

      clock.advance(1000);
      const reclaimed = await store.reservePaymentAttempt(
        reservation(2, { replayKey: 'replay_1', payer: '0xsecond', reclaimRejected: true }),
      );

      // The new reservation carries nothing over from the attempt it replaced
      assert.deepEqual(reclaimed, {
        id: reclaimed.id,
        requestId: 'req_2',
        resourceId: 'resource.report',
        provider: 'x402',
        replayKey: 'replay_1',
        status: 'reserved',
        amount: '0.01',
        currency: 'USDC',
        payer: '0xsecond',
        createdAt: reclaimed.createdAt,
        updatedAt: reclaimed.updatedAt,
      });
      assert.deepEqual(await store.listPaymentAttempts(), [reclaimed]);

      // It holds the key again: a rejected attempt can be reclaimed, a reserved one cannot
      await expectReplayed(
        store.reservePaymentAttempt(
          reservation(3, { replayKey: 'replay_1', reclaimRejected: true }),
        ),
        'reserved',
      );

      await moveTo(store, 'replay_1', 'rejected', { rejectionReason: 'backend_failed' });
      const again = await store.reservePaymentAttempt(
        reservation(4, { replayKey: 'replay_1', reclaimRejected: true }),
      );
      assert.equal(again.requestId, 'req_4');
      assert.equal(again.status, 'reserved');
    },
  },
  {
    name: 'reclaimRejected on a key nobody holds reserves it as usual',
    async run({ store }) {
      const attempt = await store.reservePaymentAttempt(reservation(1, { reclaimRejected: true }));
      assert.equal(attempt.status, 'reserved');
      assert.deepEqual(await attemptFor(store, 'replay_1'), attempt);
    },
  },
  {
    name: 'a different provider cannot reclaim a rejected attempt',
    async run({ store }) {
      await store.reservePaymentAttempt(reservation(1));
      await moveTo(store, 'replay_1', 'rejected', { rejectionReason: 'backend_failed' });
      const rejected = await attemptFor(store, 'replay_1');

      await expectReplayed(
        store.reservePaymentAttempt(
          reservation(2, { replayKey: 'replay_1', provider: 'mpp', reclaimRejected: true }),
        ),
        'rejected',
      );
      // Without the flag even the same provider has to wait for a fresh authorization
      await expectReplayed(
        store.reservePaymentAttempt(reservation(3, { replayKey: 'replay_1' })),
        'rejected',
      );
      assert.deepEqual(await store.listPaymentAttempts(), [rejected]);
    },
  },
  {
    name: 'an attempt that is not rejected cannot be reclaimed',
    async run({ store }) {
      const holders = ALL_STATUSES.filter((status) => status !== 'rejected');
      for (const [index, status] of holders.entries()) {
        const n = index + 1;
        await store.reservePaymentAttempt(reservation(n));
        await moveTo(store, `replay_${n}`, status);
        const before = await attemptFor(store, `replay_${n}`);

        await expectReplayed(
          store.reservePaymentAttempt(
            reservation(n + 10, { replayKey: `replay_${n}`, reclaimRejected: true }),
          ),
          status,
        );
        assert.deepEqual(await attemptFor(store, `replay_${n}`), before);
      }
    },
  },
  {
    name: 'concurrent reclaims of one rejected attempt let exactly one win',
    async run({ store }) {
      await store.reservePaymentAttempt(reservation(0, { replayKey: 'replay_race' }));
      await moveTo(store, 'replay_race', 'rejected', { rejectionReason: 'backend_failed' });

      const calls = Array.from({ length: RACERS }, (_, i) =>
        store.reservePaymentAttempt(
          reservation(i + 1, { replayKey: 'replay_race', reclaimRejected: true }),
        ),
      );

      const winner = soleWinner(await settle(calls));

      assert.equal(winner.status, 'reserved');
      assert.deepEqual(await store.listPaymentAttempts(), [winner]);
    },
  },
];

// --- journal ----------------------------------------------------------------

const JOURNAL_CASES: readonly CaseSpec[] = [
  {
    name: 'a reservation with transaction data opens a transaction linked to the attempt',
    uses: ['getTransaction'],
    async run({ store, clock }) {
      const attempt = await store.reservePaymentAttempt(fullJournaled(1));
      assert.equal(attempt.transactionId, 'txn_1');

      const tx = await transactionOf(journalOf(store), 'txn_1');
      assertIso(tx.createdAt);
      assertIso(tx.updatedAt);
      assert.deepEqual(tx, {
        id: 'txn_1',
        requestId: 'req_1',
        resourceId: 'resource.report',
        protocol: 'mcp',
        state: tx.state,
        payment: {
          provider: 'x402',
          attemptId: attempt.id,
          replayKey: 'replay_1',
          status: 'reserved',
          amount: '0.01',
          currency: 'USDC',
          network: 'eip155:31337',
          asset: '0xasset',
          payee: '0xmerchant',
          locator: { v: 1, nonce: '0xnonce' },
          expiresAt: isoAt(300_000),
        },
        // An included authorization starts as reserved, whatever else the caller sent
        authorization: {
          method: 'ap2',
          reference: 'sha256:mandate_1',
          metadata: { issuer: 'did:web:agent.example' },
          hold: 'reserved',
          reservationId: 'sha256:mandate_1',
        },
        inputDigest: 'sha256:input',
        configDigest: 'sha256:terms',
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
      });
      assertState(tx, factsOf('reserved'), clock.nowIso());
    },
  },
  {
    name: 'a reservation without transaction data opens no transaction',
    uses: ['listTransactions'],
    async run({ store }) {
      await store.reservePaymentAttempt(reservation(1));
      assert.deepEqual(await listAll(journalOf(store)), []);
    },
  },
  {
    name: 'a refused reservation leaves no transaction behind',
    uses: ['getTransaction', 'listTransactions'],
    async run({ store }) {
      const journal = journalOf(store);
      await store.reservePaymentAttempt(journaled(1));

      await expectReplayed(
        store.reservePaymentAttempt(journaled(2, {}, { replayKey: 'replay_1' })),
        'reserved',
      );

      assert.equal(await journal.get('txn_2'), undefined);
      assert.deepEqual(await listAll(journal), ['txn_1']);
    },
  },
  {
    name: 'concurrent reservations of one replay key open exactly one transaction',
    uses: ['listTransactions'],
    async run({ store }) {
      const calls = Array.from({ length: RACERS }, (_, i) =>
        store.reservePaymentAttempt(journaled(i, {}, { replayKey: 'replay_race' })),
      );

      const winner = soleWinner(await settle(calls));

      assert.deepEqual(await listAll(journalOf(store)), [winner.transactionId]);
    },
  },
  {
    name: 'recorded steps update the transaction and its state follows the derivation',
    uses: ['recordTransactionStep', 'getTransaction'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const read = () => transactionOf(journal, 'txn_1');
      const deadlineAt = isoAt(60_000);
      await store.reservePaymentAttempt(journaled(1, { authorization: hold(1) }));
      assertState(await read(), factsOf('reserved'), clock.nowIso());

      clock.advance(1000);
      const settlingAt = clock.nowIso();
      await journal.record({ transactionId: 'txn_1', at: settlingAt, kind: 'settling' });
      assert.equal((await read()).payment.settlingAt, settlingAt);

      clock.advance(1000);
      await store.updatePaymentAttempt({
        replayKey: 'replay_1',
        status: 'settled',
        externalReference: '0xtx',
      });
      let tx = await read();
      assert.equal(tx.payment.status, 'settled');
      assert.equal(tx.payment.externalReference, '0xtx');
      assertState(tx, factsOf('settled'), clock.nowIso());

      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'hold',
        hold: 'consumed',
      });
      assert.equal((await read()).authorization?.hold, 'consumed');

      clock.advance(1000);
      const dispatchedAt = clock.nowIso();
      await journal.record({
        transactionId: 'txn_1',
        at: dispatchedAt,
        kind: 'backend-dispatched',
        deadlineAt,
      });
      tx = await read();
      assert.deepEqual(tx.backend, { dispatchedAt, deadlineAt });
      assertState(
        tx,
        factsOf('settled', { backend: { dispatchedAt, deadlineAt } }),
        clock.nowIso(),
      );

      clock.advance(1000);
      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'backend-result',
        status: 200,
      });
      tx = await read();
      const backend = { dispatchedAt, deadlineAt, status: 200 };
      assert.deepEqual(tx.backend, backend);
      assertState(tx, factsOf('settled', { backend }), clock.nowIso());

      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'receipt',
        receiptId: 'receipt_1',
      });
      assert.equal((await read()).receiptId, 'receipt_1');

      clock.advance(1000);
      const completedAt = clock.nowIso();
      await journal.record({
        transactionId: 'txn_1',
        at: completedAt,
        kind: 'completed',
        persistenceFailures: ['journal'],
      });
      tx = await read();
      assert.equal(tx.completedAt, completedAt);
      assert.deepEqual(tx.persistenceFailures, ['journal']);
      assertState(tx, factsOf('settled', { backend, completedAt }), clock.nowIso());
      // Keep an independent expected state to catch mistakes in the shared facts
      assert.equal(tx.state, 'delivered');
    },
  },
  {
    name: 'a backend result is recorded with its status and error code',
    uses: ['recordTransactionStep', 'getTransaction'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const deadlineAt = isoAt(60_000);
      const outcomes: readonly { readonly status: number; readonly errorCode?: string }[] = [
        { status: 200 },
        { status: 500 },
        { status: 0, errorCode: 'BACKEND_TIMEOUT' },
      ];
      for (const [index, outcome] of outcomes.entries()) {
        const n = index + 1;
        await store.reservePaymentAttempt(journaled(n));
        await store.updatePaymentAttempt({ replayKey: `replay_${n}`, status: 'settled' });

        clock.advance(1000);
        const dispatchedAt = clock.nowIso();
        await journal.record({
          transactionId: `txn_${n}`,
          at: dispatchedAt,
          kind: 'backend-dispatched',
          deadlineAt,
        });
        await journal.record({
          transactionId: `txn_${n}`,
          at: clock.nowIso(),
          kind: 'backend-result',
          status: outcome.status,
          ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
        });
        const completedAt = clock.nowIso();
        await journal.record({ transactionId: `txn_${n}`, at: completedAt, kind: 'completed' });

        const tx = await transactionOf(journal, `txn_${n}`);
        const backend = { dispatchedAt, deadlineAt, ...outcome };
        assert.deepEqual(tx.backend, backend);
        assert.equal(tx.completedAt, completedAt);
        assertState(tx, factsOf('settled', { backend, completedAt }), clock.nowIso());
      }
    },
  },
  {
    name: 'a payment attempt update moves the state of its transaction',
    uses: ['getTransaction', 'listTransactions'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const statuses = ['settled', 'rejected', 'settlement-uncertain', 'failed'] as const;
      for (const [index, status] of statuses.entries()) {
        const n = index + 1;
        await store.reservePaymentAttempt(journaled(n));
        await store.updatePaymentAttempt({ replayKey: `replay_${n}`, status });
        clock.advance(1000);

        const tx = await transactionOf(journal, `txn_${n}`);
        assert.equal(tx.payment.status, status);
        assertState(tx, factsOf(status), clock.nowIso());
      }

      // The state filter finds each transaction under the state its attempt now implies
      const stateOf = (status: AttemptStatus) => transactionState(factsOf(status), clock.nowIso());
      for (const state of new Set(statuses.map(stateOf))) {
        const expected = statuses
          .flatMap((status, index) => (stateOf(status) === state ? [`txn_${index + 1}`] : []))
          .reverse();
        assert.deepEqual(await listAll(journal, { state }), expected, state);
      }
    },
  },
  {
    name: 'transactions list newest first and cursor pages continue to the end without repeats',
    uses: ['listTransactions'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      for (let n = 1; n <= 5; n += 1) {
        await store.reservePaymentAttempt(journaled(n));
        clock.advance(1000);
      }
      const newestFirst = ['txn_5', 'txn_4', 'txn_3', 'txn_2', 'txn_1'];

      assert.deepEqual(await listAll(journal), newestFirst);

      const pages = await walk(journal, { limit: 2 });
      assert.ok(pages.every((page) => page.transactions.length <= 2));
      assert.deepEqual(
        pages.flatMap((page) => ids(page.transactions)),
        newestFirst,
      );
    },
  },
  {
    name: 'transactions filter by request, state, unresolved and pending hold',
    uses: ['recordTransactionStep', 'listTransactions'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const deadlineAt = isoAt(60_000);

      // 1 payment-failed, 2 payment-pending with a reserved hold, 3 delivered with a consumed
      // hold, 4 payment-uncertain with an uncertain hold, 5 settled-undelivered
      await store.reservePaymentAttempt(journaled(1));
      await moveTo(store, 'replay_1', 'rejected');
      clock.advance(1000);
      await store.reservePaymentAttempt(journaled(2, { authorization: hold(2) }));
      clock.advance(1000);
      await store.reservePaymentAttempt(journaled(3, { authorization: hold(3) }));
      await moveTo(store, 'replay_3', 'settled');
      for (const step of [
        { kind: 'hold', hold: 'consumed' },
        { kind: 'backend-dispatched', deadlineAt },
        { kind: 'backend-result', status: 200 },
        { kind: 'completed' },
      ] as const) {
        await journal.record({ transactionId: 'txn_3', at: clock.nowIso(), ...step });
      }
      clock.advance(1000);
      await store.reservePaymentAttempt(journaled(4, { authorization: hold(4) }));
      await moveTo(store, 'replay_4', 'settlement-uncertain');
      await journal.record({
        transactionId: 'txn_4',
        at: clock.nowIso(),
        kind: 'hold',
        hold: 'uncertain',
      });
      clock.advance(1000);
      await store.reservePaymentAttempt(journaled(5));
      await moveTo(store, 'replay_5', 'settled');

      const now = clock.nowIso();
      const delivered = factsOf('settled', {
        backend: { dispatchedAt: now, deadlineAt, status: 200 },
        completedAt: now,
      });
      const stateOf = (facts: TransactionFacts) => transactionState(facts, now);

      assert.deepEqual(await listAll(journal, { requestId: 'req_2' }), ['txn_2']);
      assert.deepEqual(await listAll(journal, { state: stateOf(factsOf('reserved')) }), ['txn_2']);
      assert.deepEqual(await listAll(journal, { state: stateOf(factsOf('rejected')) }), ['txn_1']);
      assert.deepEqual(
        await listAll(journal, { state: stateOf(factsOf('settlement-uncertain')) }),
        ['txn_4'],
      );
      assert.deepEqual(await listAll(journal, { state: stateOf(delivered) }), ['txn_3']);
      assert.deepEqual(await listAll(journal, { unresolved: true }), ['txn_5', 'txn_4', 'txn_2']);
      assert.deepEqual(await listAll(journal, { pendingHold: true }), ['txn_4', 'txn_2']);
      assert.deepEqual(await listAll(journal, { unresolved: true, pendingHold: true }), [
        'txn_4',
        'txn_2',
      ]);
      // A filter may leave a page short, so the cursor must still lead to every match
      assert.deepEqual(await listAll(journal, { unresolved: true, limit: 1 }), [
        'txn_5',
        'txn_4',
        'txn_2',
      ]);
    },
  },
  {
    name: 'getPaymentAttempt finds an attempt by id',
    uses: ['getPaymentAttempt'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const first = await store.reservePaymentAttempt(reservation(1));
      const second = await store.reservePaymentAttempt(reservation(2));
      assert.deepEqual(await attemptById(journal, first.id), first);
      assert.deepEqual(await attemptById(journal, second.id), second);

      clock.advance(1000);
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settled' });
      assert.deepEqual(await attemptById(journal, first.id), await attemptFor(store, 'replay_1'));
      assert.equal(await journal.attempt('attempt_missing'), undefined);
    },
  },
  {
    name: 'getPaymentAttempt still finds an attempt a reclaim replaced, and its transaction keeps it',
    uses: ['getPaymentAttempt', 'getTransaction'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const replaced = await store.reservePaymentAttempt(journaled(1));
      await moveTo(store, 'replay_1', 'rejected', { rejectionReason: 'backend_failed' });
      clock.advance(1000);

      const reclaimed = await store.reservePaymentAttempt(
        journaled(2, {}, { replayKey: 'replay_1', reclaimRejected: true }),
      );

      assert.notEqual(reclaimed.id, replaced.id);
      const old = await attemptById(journal, replaced.id);
      assert.equal(old.requestId, 'req_1');
      assert.equal(old.status, 'rejected');
      assert.equal(old.rejectionReason, 'backend_failed');
      assert.deepEqual(await attemptById(journal, reclaimed.id), reclaimed);

      const oldTx = await transactionOf(journal, 'txn_1');
      assert.equal(oldTx.payment.attemptId, replaced.id);
      assert.equal(oldTx.payment.status, 'rejected');
      assertState(oldTx, factsOf('rejected'), clock.nowIso());
      const newTx = await transactionOf(journal, 'txn_2');
      assert.equal(newTx.payment.attemptId, reclaimed.id);
      assert.equal(newTx.payment.status, 'reserved');

      // An update follows the replay key to the live attempt only
      await store.updatePaymentAttempt({ replayKey: 'replay_1', status: 'settled' });
      assert.equal((await transactionOf(journal, 'txn_2')).payment.status, 'settled');
      assert.equal((await transactionOf(journal, 'txn_1')).payment.status, 'rejected');
      assert.equal((await attemptById(journal, replaced.id)).status, 'rejected');
    },
  },
];

// --- resolution -------------------------------------------------------------

const RESOLUTION_CASES: readonly CaseSpec[] = [
  {
    name: 'resolving an uncertain attempt records the resolution and moves its transaction',
    uses: ['resolvePaymentAttempt', 'getPaymentAttempt', 'getTransaction'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const outcomes = [
        { status: 'settled' },
        { status: 'rejected', rejectionReason: 'not_settled' },
      ] as const;
      for (const [index, outcome] of outcomes.entries()) {
        const n = index + 1;
        const attempt = await uncertain(store, n);
        clock.advance(1000);

        const won = await journal.resolve({
          attemptId: attempt.id,
          expectedStatus: 'settlement-uncertain',
          ...outcome,
          resolution: RESOLUTION,
        });

        assert.equal(won, true);
        const resolved = await attemptById(journal, attempt.id);
        assert.equal(resolved.status, outcome.status);
        assert.deepEqual(resolved.resolution, RESOLUTION);
        if ('rejectionReason' in outcome) {
          assert.equal(resolved.rejectionReason, outcome.rejectionReason);
        }
        assert.deepEqual(await attemptFor(store, `replay_${n}`), resolved);
        const tx = await transactionOf(journal, `txn_${n}`);
        assert.equal(tx.payment.status, outcome.status);
        assertState(tx, factsOf(outcome.status), clock.nowIso());
      }
    },
  },
  {
    name: 'resolvePaymentAttempt returns false and writes nothing when the expected status differs',
    uses: ['resolvePaymentAttempt', 'getPaymentAttempt', 'getTransaction'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const attempt = await uncertain(store, 1);
      const before = await attemptById(journal, attempt.id);

      const won = await journal.resolve({
        attemptId: attempt.id,
        expectedStatus: 'reserved',
        status: 'settled',
        resolution: RESOLUTION,
      });

      assert.equal(won, false);
      assert.deepEqual(await attemptById(journal, attempt.id), before);
      assertState(
        await transactionOf(journal, 'txn_1'),
        factsOf('settlement-uncertain'),
        clock.nowIso(),
      );
    },
  },
  {
    name: 'resolvePaymentAttempt refuses a second resolution even when the expected status matches',
    uses: ['resolvePaymentAttempt', 'getPaymentAttempt'],
    async run({ store }) {
      const journal = journalOf(store);
      const attempt = await uncertain(store, 1);
      assert.equal(
        await journal.resolve({
          attemptId: attempt.id,
          expectedStatus: 'settlement-uncertain',
          status: 'settled',
          resolution: RESOLUTION,
        }),
        true,
      );
      const resolved = await attemptById(journal, attempt.id);

      const again = await journal.resolve({
        attemptId: attempt.id,
        expectedStatus: 'settled',
        status: 'rejected',
        resolution: { ...RESOLUTION, method: 'manual', actor: 'operator' },
      });

      assert.equal(again, false);
      assert.deepEqual(await attemptById(journal, attempt.id), resolved);
    },
  },
  {
    name: 'an attempt with a resolution cannot be changed by updatePaymentAttempt',
    uses: ['resolvePaymentAttempt', 'getPaymentAttempt'],
    async run({ store, clock }) {
      const journal = journalOf(store);
      const attempt = await uncertain(store, 1);
      await journal.resolve({
        attemptId: attempt.id,
        expectedStatus: 'settlement-uncertain',
        status: 'settled',
        resolution: RESOLUTION,
      });
      const resolved = await attemptById(journal, attempt.id);
      clock.advance(1000);

      // The code is the store's own; refusing the write is what the contract fixes
      await assert.rejects(
        store.updatePaymentAttempt({
          replayKey: 'replay_1',
          status: 'rejected',
          rejectionReason: 'late_write',
          externalReference: '0xother',
        }),
      );

      assert.deepEqual(await attemptById(journal, attempt.id), resolved);
    },
  },
  {
    name: 'concurrent resolutions of one attempt let exactly one win',
    uses: ['resolvePaymentAttempt', 'getPaymentAttempt'],
    async run({ store }) {
      const journal = journalOf(store);
      const attempt = await uncertain(store, 1);

      const results = await Promise.all(
        Array.from({ length: RACERS }, (_, i) =>
          journal.resolve({
            attemptId: attempt.id,
            expectedStatus: 'settlement-uncertain',
            status: i % 2 === 0 ? 'settled' : 'rejected',
            resolution: { ...RESOLUTION, actor: `actor_${i}` },
          }),
        ),
      );

      assert.equal(results.filter((won) => won).length, 1);
      // The stored resolution is the winner's, not a mix of two
      const winner = results.indexOf(true);
      const resolved = await attemptById(journal, attempt.id);
      assert.equal(resolved.resolution?.actor, `actor_${winner}`);
      assert.equal(resolved.status, winner % 2 === 0 ? 'settled' : 'rejected');
    },
  },
];

// --- durability -------------------------------------------------------------

const DURABILITY_CASES: readonly CaseSpec[] = [
  {
    name: 'receipts, events and payment attempts read back identically after a reopen',
    needsReopen: true,
    async run({ store, clock, reopen }) {
      await store.saveReceipt(FULL_RECEIPT);
      await store.saveReceipt(receipt('receipt_failed', { backendStatus: 502 }));
      await store.appendEvent(FULL_EVENT);
      await store.reservePaymentAttempt(reservation(1, { payer: '0xbuyer', payee: '0xmerchant' }));
      await moveTo(store, 'replay_1', 'settled', { externalReference: '0xtx' });
      clock.advance(1000);
      await store.reservePaymentAttempt(reservation(2));
      await moveTo(store, 'replay_2', 'settlement-uncertain', { externalReference: '0xhash' });
      clock.advance(1000);
      await store.reservePaymentAttempt(reservation(3));
      await moveTo(store, 'replay_3', 'rejected', { rejectionReason: 'backend_failed' });
      const readAttempts = (target: ReceiptStore) =>
        Promise.all([1, 2, 3].map((n) => attemptFor(target, `replay_${n}`)));
      const before = await readAttempts(store);

      const reopened = await reopen();

      assert.deepEqual(await reopened.getReceipt(FULL_RECEIPT.id), FULL_RECEIPT);
      assert.equal(await reopened.countReceipts(), 2);
      assert.equal(await reopened.countUndeliveredReceipts(), 1);
      assert.deepEqual(await reopened.listEvents(), [FULL_EVENT]);
      assert.deepEqual(await readAttempts(reopened), before);
      assert.equal(await reopened.countUncertainPaymentAttempts(), 1);

      // A key spent before the restart is still spent
      await expectReplayed(
        reopened.reservePaymentAttempt(reservation(4, { replayKey: 'replay_1' })),
        'settled',
      );
      const fresh = await reopened.reservePaymentAttempt(reservation(5));
      assert.equal(fresh.status, 'reserved');
    },
  },
  {
    name: 'transactions, steps and resolutions read back identically after a reopen',
    uses: [
      'recordTransactionStep',
      'getTransaction',
      'listTransactions',
      'getPaymentAttempt',
      'resolvePaymentAttempt',
    ],
    needsReopen: true,
    async run({ store, clock, reopen }) {
      const journal = journalOf(store);
      const first = await store.reservePaymentAttempt(fullJournaled(1));
      clock.advance(1000);
      await journal.record({ transactionId: 'txn_1', at: clock.nowIso(), kind: 'settling' });
      await store.updatePaymentAttempt({
        replayKey: 'replay_1',
        status: 'settled',
        externalReference: '0xtx',
      });
      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'hold',
        hold: 'consumed',
      });
      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'backend-dispatched',
        deadlineAt: isoAt(60_000),
      });
      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'backend-result',
        status: 200,
      });
      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'receipt',
        receiptId: 'receipt_1',
      });
      await journal.record({
        transactionId: 'txn_1',
        at: clock.nowIso(),
        kind: 'completed',
        persistenceFailures: ['journal'],
      });
      clock.advance(1000);
      const second = await uncertain(store, 2);
      await journal.resolve({
        attemptId: second.id,
        expectedStatus: 'settlement-uncertain',
        status: 'settled',
        resolution: RESOLUTION,
      });
      const txBefore = [
        await transactionOf(journal, 'txn_1'),
        await transactionOf(journal, 'txn_2'),
      ];
      const attemptsBefore = [
        await attemptById(journal, first.id),
        await attemptById(journal, second.id),
      ];
      const listBefore = await listAll(journal);

      const reopened = journalOf(await reopen());

      assert.deepEqual(
        [await transactionOf(reopened, 'txn_1'), await transactionOf(reopened, 'txn_2')],
        txBefore,
      );
      assert.deepEqual(
        [await attemptById(reopened, first.id), await attemptById(reopened, second.id)],
        attemptsBefore,
      );
      assert.deepEqual(await listAll(reopened), listBefore);
      assert.deepEqual(listBefore, ['txn_2', 'txn_1']);
    },
  },
];

export const CORE_CASES: readonly CaseSpec[] = [
  ...RECEIPT_CASES,
  ...EVENT_CASES,
  ...ATTEMPT_CASES,
  ...REPLAY_CASES,
  ...RECLAIM_CASES,
  ...JOURNAL_CASES,
  ...RESOLUTION_CASES,
  ...DURABILITY_CASES,
];
