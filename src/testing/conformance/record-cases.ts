// Conformance cases for the 2.6.0 records: idempotency claims, authorization
// holds and pending tasks
import assert from 'node:assert/strict';
import type {
  AuthorizationHoldReservation,
  IdempotencyScope,
  PendingTask,
  ReceiptStore,
} from '../../core';
import { type CaseSpec, isoAt } from './support';

const CLAIMS = ['claimIdempotencyKey', 'updateIdempotencyKey', 'recoverIdempotencyKeys'] as const;
const HOLDS = [
  'reserveAuthorizationHold',
  'transitionAuthorizationHold',
  'getAuthorizationHoldState',
  'listOrphanAuthorizationHolds',
] as const;
const TASKS = ['putPendingTask', 'getPendingTask', 'takePendingTask'] as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Cases list these methods in `uses`; runners must skip cases missing them
type Claims = Required<Pick<ReceiptStore, (typeof CLAIMS)[number]>>;
type Holds = Required<Pick<ReceiptStore, (typeof HOLDS)[number]>>;
type Tasks = Required<Pick<ReceiptStore, (typeof TASKS)[number]>>;
const claims = (store: ReceiptStore) => store as ReceiptStore & Claims;
const holds = (store: ReceiptStore) => store as ReceiptStore & Holds;
const tasks = (store: ReceiptStore) => store as ReceiptStore & Tasks;

const scope = (key: string, endpoint = '/acp/checkout_sessions'): IdempotencyScope => ({
  deployment: 'https://gateway.example',
  endpoint,
  key,
});

const hold = (
  reference: string,
  fields: Partial<AuthorizationHoldReservation> = {},
): AuthorizationHoldReservation => ({
  method: 'ap2',
  reference,
  bindingReference: `binding-of-${reference}`,
  resourceId: 'resource.report',
  requestId: `req-${reference}`,
  ...fields,
});

const task = (id: string, fields: Partial<PendingTask> = {}): PendingTask => ({
  id,
  protocol: 'a2a',
  resourceId: 'resource.report',
  input: { symbol: 'ETH' },
  expiresAt: isoAt(10 * MINUTE),
  ...fields,
});

const count = <T>(values: readonly T[], predicate: (value: T) => boolean): number =>
  values.filter(predicate).length;

const CLAIM_CASES: readonly CaseSpec[] = [
  {
    name: 'a new idempotency scope is reserved and a repeat while it runs is in flight',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      assert.deepEqual(await s.claimIdempotencyKey(scope('k1'), 'fp', isoAt(DAY)), {
        kind: 'reserved',
      });
      assert.deepEqual(await s.claimIdempotencyKey(scope('k1'), 'fp', isoAt(DAY)), {
        kind: 'in-flight',
      });
    },
  },
  {
    name: 'a different fingerprint conflicts whatever the claim state',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      await s.claimIdempotencyKey(scope('running'), 'fp', isoAt(DAY));
      await s.claimIdempotencyKey(scope('done'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('done'), { kind: 'completed', status: 201, body: {} });
      await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('unknown'), { kind: 'unresolved' });
      for (const key of ['running', 'done', 'unknown']) {
        assert.deepEqual(
          await s.claimIdempotencyKey(scope(key), 'other', isoAt(DAY)),
          { kind: 'conflict' },
          key,
        );
      }
    },
  },
  {
    name: 'a completed claim replays its status and body',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      const body = { id: 'cs_1', line_items: [{ id: 'item', quantity: 2 }], note: null };
      await s.claimIdempotencyKey(scope('k1'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('k1'), { kind: 'completed', status: 201, body });
      assert.deepEqual(await s.claimIdempotencyKey(scope('k1'), 'fp', isoAt(DAY)), {
        kind: 'replay',
        status: 201,
        body,
      });
    },
  },
  {
    name: 'an unresolved claim refuses retries and a released one can be claimed again',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('unknown'), { kind: 'unresolved' });
      assert.deepEqual(await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY)), {
        kind: 'unresolved',
      });
      await s.claimIdempotencyKey(scope('freed'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('freed'), { kind: 'released' });
      assert.deepEqual(await s.claimIdempotencyKey(scope('freed'), 'other', isoAt(DAY)), {
        kind: 'reserved',
      });
    },
  },
  {
    name: 'an idempotency scope is the deployment, endpoint and key together',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      const base = scope('k1');
      await s.claimIdempotencyKey(base, 'fp', isoAt(DAY));
      for (const other of [
        { ...base, deployment: 'https://other.example' },
        { ...base, endpoint: '/acp/checkout_sessions/cs_1' },
        { ...base, key: 'k2' },
      ]) {
        assert.deepEqual(await s.claimIdempotencyKey(other, 'fp', isoAt(DAY)), {
          kind: 'reserved',
        });
      }
    },
  },
  {
    name: 'only completed claims expire',
    uses: CLAIMS,
    async run({ store, clock }) {
      const s = claims(store);
      await s.claimIdempotencyKey(scope('done'), 'fp', isoAt(MINUTE));
      await s.updateIdempotencyKey(scope('done'), { kind: 'completed', status: 200, body: {} });
      await s.claimIdempotencyKey(scope('running'), 'fp', isoAt(MINUTE));
      await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(MINUTE));
      await s.updateIdempotencyKey(scope('unknown'), { kind: 'unresolved' });

      clock.advance(MINUTE - 1);
      assert.equal((await s.claimIdempotencyKey(scope('done'), 'fp', isoAt(DAY))).kind, 'replay');

      clock.advance(2);
      assert.deepEqual(await s.claimIdempotencyKey(scope('done'), 'other', isoAt(DAY)), {
        kind: 'reserved',
      });
      assert.deepEqual(await s.claimIdempotencyKey(scope('running'), 'fp', isoAt(DAY)), {
        kind: 'in-flight',
      });
      assert.deepEqual(await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY)), {
        kind: 'unresolved',
      });
    },
  },
  {
    name: 'recovery marks in-flight claims unresolved and counts them',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      await s.claimIdempotencyKey(scope('a'), 'fp', isoAt(DAY));
      await s.claimIdempotencyKey(scope('b'), 'fp', isoAt(DAY));
      await s.claimIdempotencyKey(scope('done'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('done'), { kind: 'completed', status: 200, body: 1 });

      assert.equal(await s.recoverIdempotencyKeys({ release: false }), 2);
      assert.deepEqual(await s.claimIdempotencyKey(scope('a'), 'fp', isoAt(DAY)), {
        kind: 'unresolved',
      });
      assert.equal((await s.claimIdempotencyKey(scope('done'), 'fp', isoAt(DAY))).kind, 'replay');
      assert.equal(await s.recoverIdempotencyKeys({ release: false }), 0);
    },
  },
  {
    name: 'recovery with release deletes in-flight claims only',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      await s.claimIdempotencyKey(scope('a'), 'fp', isoAt(DAY));
      await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('unknown'), { kind: 'unresolved' });

      assert.equal(await s.recoverIdempotencyKeys({ release: true }), 1);
      assert.deepEqual(await s.claimIdempotencyKey(scope('a'), 'fp', isoAt(DAY)), {
        kind: 'reserved',
      });
      assert.deepEqual(await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY)), {
        kind: 'unresolved',
      });
    },
  },
  {
    name: 'concurrent claims of one idempotency scope reserve it once',
    uses: CLAIMS,
    async run({ store }) {
      const s = claims(store);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => s.claimIdempotencyKey(scope('k1'), 'fp', isoAt(DAY))),
      );
      assert.equal(
        count(results, (r) => r.kind === 'reserved'),
        1,
      );
      assert.equal(
        count(results, (r) => r.kind === 'in-flight'),
        7,
      );
    },
  },
  {
    name: 'idempotency claims survive a reopen',
    uses: CLAIMS,
    needsReopen: true,
    async run({ store, reopen }) {
      const s = claims(store);
      await s.claimIdempotencyKey(scope('done'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('done'), { kind: 'completed', status: 201, body: [1] });
      await s.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY));
      await s.updateIdempotencyKey(scope('unknown'), { kind: 'unresolved' });

      const reopened = claims(await reopen());
      assert.deepEqual(await reopened.claimIdempotencyKey(scope('done'), 'fp', isoAt(DAY)), {
        kind: 'replay',
        status: 201,
        body: [1],
      });
      assert.deepEqual(await reopened.claimIdempotencyKey(scope('unknown'), 'fp', isoAt(DAY)), {
        kind: 'unresolved',
      });
    },
  },
];

const HOLD_CASES: readonly CaseSpec[] = [
  {
    name: 'a new authorization hold is reserved',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      assert.equal(await s.getAuthorizationHoldState('ref1'), undefined);
      assert.deepEqual(await s.reserveAuthorizationHold(hold('ref1')), { kind: 'reserved' });
      assert.equal(await s.getAuthorizationHoldState('ref1'), 'reserved');
    },
  },
  {
    name: 'a held reference is refused with its state',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      for (const to of ['consumed', 'uncertain'] as const) {
        const ref = `ref-${to}`;
        await s.reserveAuthorizationHold(hold(ref));
        assert.deepEqual(await s.reserveAuthorizationHold(hold(ref, { requestId: 'req-2' })), {
          kind: 'replayed',
          state: 'reserved',
        });
        assert.equal(await s.transitionAuthorizationHold(ref, to), true);
        assert.deepEqual(await s.reserveAuthorizationHold(hold(ref, { requestId: 'req-3' })), {
          kind: 'replayed',
          state: to,
        });
      }
    },
  },
  {
    name: 'a binding takes a second reference only after the first is released',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      const shared = { bindingReference: 'checkout-jti' };
      await s.reserveAuthorizationHold(hold('ref1', shared));
      assert.deepEqual(await s.reserveAuthorizationHold(hold('ref2', shared)), {
        kind: 'replayed',
        state: 'reserved',
      });
      assert.equal(await s.getAuthorizationHoldState('ref2'), undefined);

      await s.transitionAuthorizationHold('ref1', 'released');
      assert.deepEqual(await s.reserveAuthorizationHold(hold('ref2', shared)), {
        kind: 'reserved',
      });
      // ref1 is released, but its binding is held again, now by ref2
      assert.deepEqual(await s.reserveAuthorizationHold(hold('ref1', shared)), {
        kind: 'replayed',
        state: 'reserved',
      });
    },
  },
  {
    name: 'consumed and released holds are final',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      await s.reserveAuthorizationHold(hold('spent'));
      await s.transitionAuthorizationHold('spent', 'consumed');
      assert.equal(await s.transitionAuthorizationHold('spent', 'released'), false);
      assert.equal(await s.transitionAuthorizationHold('spent', 'uncertain'), false);
      assert.equal(await s.getAuthorizationHoldState('spent'), 'consumed');

      await s.reserveAuthorizationHold(hold('freed'));
      await s.transitionAuthorizationHold('freed', 'released');
      assert.equal(await s.transitionAuthorizationHold('freed', 'consumed'), false);
      assert.equal(await s.getAuthorizationHoldState('freed'), 'released');
    },
  },
  {
    name: 'a repeated hold transition returns true, and a missing hold false',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      await s.reserveAuthorizationHold(hold('ref1'));
      assert.equal(await s.transitionAuthorizationHold('ref1', 'consumed', 'req-ref1'), true);
      assert.equal(await s.transitionAuthorizationHold('ref1', 'consumed', 'req-ref1'), true);
      assert.equal(await s.transitionAuthorizationHold('missing', 'released'), false);
    },
  },
  {
    name: 'an uncertain hold can still be consumed or released',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      for (const to of ['consumed', 'released'] as const) {
        await s.reserveAuthorizationHold(hold(to));
        assert.equal(await s.transitionAuthorizationHold(to, 'uncertain'), true);
        assert.equal(await s.transitionAuthorizationHold(to, to), true);
        assert.equal(await s.getAuthorizationHoldState(to), to);
      }
    },
  },
  {
    name: 'a former holder cannot change a hold reserved by a new request',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      await s.reserveAuthorizationHold(hold('ref1', { requestId: 'req-a' }));
      assert.equal(await s.transitionAuthorizationHold('ref1', 'released', 'req-a'), true);
      assert.deepEqual(await s.reserveAuthorizationHold(hold('ref1', { requestId: 'req-b' })), {
        kind: 'reserved',
      });

      assert.equal(await s.transitionAuthorizationHold('ref1', 'consumed', 'req-a'), false);
      assert.equal(await s.transitionAuthorizationHold('ref1', 'uncertain', 'req-a'), false);
      // A late release from the old holder is acknowledged and changes nothing
      assert.equal(await s.transitionAuthorizationHold('ref1', 'released', 'req-a'), true);
      assert.equal(await s.getAuthorizationHoldState('ref1'), 'reserved');
      assert.equal(await s.transitionAuthorizationHold('ref1', 'consumed', 'req-b'), true);
    },
  },
  {
    name: 'orphan holds are old reserved holds whose request has no payment attempt',
    uses: HOLDS,
    async run({ store, clock }) {
      const s = holds(store);
      const attempt = (requestId: string, replayKey: string) => ({
        requestId,
        resourceId: 'resource.report',
        provider: 'x402',
        replayKey,
        amount: '0.01',
        currency: 'USDC',
      });
      const metadata = { mandateIssuer: 'https://issuer.example' };
      await s.reserveAuthorizationHold(hold('orphan', { requestId: 'req-orphan', metadata }));
      await s.reserveAuthorizationHold(hold('paying', { requestId: 'req-paying' }));
      await s.reservePaymentAttempt(attempt('req-paying', 'rk-paying'));
      await s.reserveAuthorizationHold(hold('spent', { requestId: 'req-spent' }));
      await s.transitionAuthorizationHold('spent', 'consumed');
      // Its attempt is rejected, then replaced when the store supports reclaim
      await s.reserveAuthorizationHold(hold('replaced', { requestId: 'req-replaced' }));
      await s.reservePaymentAttempt(attempt('req-replaced', 'rk-replaced'));
      await s.updatePaymentAttempt({ replayKey: 'rk-replaced', status: 'rejected' });
      await s
        .reservePaymentAttempt({ ...attempt('req-retry', 'rk-replaced'), reclaimRejected: true })
        .catch(() => undefined);
      clock.advance(10 * MINUTE);
      await s.reserveAuthorizationHold(hold('young', { requestId: 'req-young' }));
      clock.advance(MINUTE);

      const orphans = await s.listOrphanAuthorizationHolds({ updatedBefore: isoAt(5 * MINUTE) });
      assert.deepEqual(orphans, [
        {
          ...hold('orphan', { requestId: 'req-orphan', metadata }),
          state: 'reserved',
          createdAt: isoAt(0),
          updatedAt: isoAt(0),
        },
      ]);
      const all = await s.listOrphanAuthorizationHolds({ updatedBefore: isoAt(11 * MINUTE) });
      assert.deepEqual(
        all.map((h) => h.reference),
        ['orphan', 'young'],
      );
      const first = await s.listOrphanAuthorizationHolds({
        updatedBefore: isoAt(11 * MINUTE),
        limit: 1,
      });
      assert.deepEqual(
        first.map((h) => h.reference),
        ['orphan'],
      );
    },
  },
  {
    name: 'concurrent reservations of one reference reserve it once',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          s.reserveAuthorizationHold(hold('ref1', { requestId: `req-${i}` })),
        ),
      );
      assert.equal(
        count(results, (r) => r.kind === 'reserved'),
        1,
      );
      assert.equal(
        count(results, (r) => r.kind === 'replayed'),
        7,
      );
    },
  },
  {
    name: 'concurrent reservations of two references on one binding reserve one',
    uses: HOLDS,
    async run({ store }) {
      const s = holds(store);
      const shared = { bindingReference: 'checkout-jti' };
      const results = await Promise.all([
        s.reserveAuthorizationHold(hold('ref1', shared)),
        s.reserveAuthorizationHold(hold('ref2', shared)),
      ]);
      assert.equal(
        count(results, (r) => r.kind === 'reserved'),
        1,
      );
    },
  },
  {
    name: 'authorization holds survive a reopen',
    uses: HOLDS,
    needsReopen: true,
    async run({ store, reopen }) {
      const s = holds(store);
      await s.reserveAuthorizationHold(hold('spent'));
      await s.transitionAuthorizationHold('spent', 'consumed');
      await s.reserveAuthorizationHold(hold('held'));

      const reopened = holds(await reopen());
      assert.equal(await reopened.getAuthorizationHoldState('spent'), 'consumed');
      assert.deepEqual(await reopened.reserveAuthorizationHold(hold('spent')), {
        kind: 'replayed',
        state: 'consumed',
      });
      assert.deepEqual(
        await reopened.reserveAuthorizationHold(
          hold('other', { bindingReference: 'binding-of-held' }),
        ),
        { kind: 'replayed', state: 'reserved' },
      );
    },
  },
];

const TASK_CASES: readonly CaseSpec[] = [
  {
    name: 'a pending task reads back until it is taken, and only once',
    uses: TASKS,
    async run({ store }) {
      const s = tasks(store);
      const stored = task('task1', { adapterData: { contextId: 'ctx', network: 'eip155:8453' } });
      assert.equal(await s.putPendingTask(stored, { maxTasks: 10 }), true);
      assert.deepEqual(await s.getPendingTask('task1'), stored);
      assert.deepEqual(await s.takePendingTask('task1'), stored);
      assert.equal(await s.getPendingTask('task1'), undefined);
      assert.equal(await s.takePendingTask('task1'), undefined);

      const plain = task('task2');
      await s.putPendingTask(plain, { maxTasks: 10 });
      assert.deepEqual(await s.getPendingTask('task2'), plain);
    },
  },
  {
    name: 'a pending task with the same id replaces the earlier one',
    uses: TASKS,
    async run({ store }) {
      const s = tasks(store);
      await s.putPendingTask(task('task1'), { maxTasks: 10 });
      const replacement = task('task1', { input: { symbol: 'BTC' } });
      await s.putPendingTask(replacement, { maxTasks: 10 });
      assert.deepEqual(await s.getPendingTask('task1'), replacement);
    },
  },
  {
    name: 'an expired pending task cannot be read or taken',
    uses: TASKS,
    async run({ store, clock }) {
      const s = tasks(store);
      const stored = task('task1', { expiresAt: isoAt(MINUTE) });
      await s.putPendingTask(stored, { maxTasks: 10 });
      clock.advance(MINUTE - 1);
      assert.deepEqual(await s.getPendingTask('task1'), stored);
      clock.advance(2);
      assert.equal(await s.getPendingTask('task1'), undefined);
      assert.equal(await s.takePendingTask('task1'), undefined);
    },
  },
  {
    name: 'maxTasks refuses a task while that many are unexpired',
    uses: TASKS,
    async run({ store, clock }) {
      const s = tasks(store);
      const soon = { expiresAt: isoAt(MINUTE) };
      assert.equal(await s.putPendingTask(task('a', soon), { maxTasks: 2 }), true);
      assert.equal(await s.putPendingTask(task('b', soon), { maxTasks: 2 }), true);
      assert.equal(await s.putPendingTask(task('c'), { maxTasks: 2 }), false);
      assert.equal(await s.getPendingTask('c'), undefined);

      // Expired tasks free capacity for new tasks
      clock.advance(MINUTE + 1);
      assert.equal(await s.putPendingTask(task('c'), { maxTasks: 2 }), true);
      assert.equal(await s.putPendingTask(task('d'), { maxTasks: 2 }), true);
      assert.equal(await s.putPendingTask(task('e'), { maxTasks: 2 }), false);
    },
  },
  {
    name: 'concurrent takes of one pending task return it once',
    uses: TASKS,
    async run({ store }) {
      const s = tasks(store);
      await s.putPendingTask(task('task1'), { maxTasks: 10 });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => s.takePendingTask('task1')),
      );
      assert.equal(
        count(results, (r) => r !== undefined),
        1,
      );
    },
  },
  {
    name: 'pending tasks survive a reopen',
    uses: TASKS,
    needsReopen: true,
    async run({ store, reopen }) {
      const s = tasks(store);
      const stored = task('task1', { adapterData: { contextId: 'ctx' } });
      await s.putPendingTask(stored, { maxTasks: 10 });
      const reopened = tasks(await reopen());
      assert.deepEqual(await reopened.takePendingTask('task1'), stored);
    },
  },
];

export const RECORD_CASES: readonly CaseSpec[] = [...CLAIM_CASES, ...HOLD_CASES, ...TASK_CASES];
