// Operator transaction reads and manual resolution through Fastify
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['NODE_ENV'] = 'test';

import {
  type Ap2ReplayStore,
  createAp2ReplayStore,
} from '../../../src/authorization/ap2/replay-store';
import type {
  AuthorizationProvider,
  BackendExecutor,
  Clock,
  PaymentAttemptReservation,
  ReceiptStore,
} from '../../../src/core';
import { NOOP_LOGGER } from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway/server';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { makeEvent, makeReceipt } from '../storage-receipts/helpers';
import { makeGatewayConfig } from './helpers';

const TOKEN = 'operator-token';
const T0 = '2026-10-28T12:00:00.000Z';
const NOW = '2026-10-28T12:30:00.000Z';

function clockAt(iso: string): Clock {
  const ms = Date.parse(iso);
  return {
    now: () => new Date(ms),
    nowIso: () => new Date(ms).toISOString(),
    monotonicMs: () => ms,
  };
}

// Advance the store clock in seed() to control each row's creation time
let storeTime = Date.parse(T0);
const storeClock: Clock = {
  now: () => new Date(storeTime),
  nowIso: () => new Date(storeTime).toISOString(),
  monotonicMs: () => storeTime,
};

let store: ReceiptStore;
let replay: Ap2ReplayStore;
let gateways: GatewayInstance[];

beforeEach(async () => {
  storeTime = Date.parse(T0);
  store = createSqliteReceiptStore({ path: ':memory:', clock: storeClock });
  await store.init();
  replay = createAp2ReplayStore({ path: ':memory:' });
  gateways = [];
});

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close().catch(() => {})));
  await store.close();
  replay.close();
});

function ap2Provider(): AuthorizationProvider {
  const finalize =
    (action: 'consume' | 'release' | 'markUncertain') =>
    async (reservationId: string, context: { requestId: string }) =>
      replay[action](reservationId, context.requestId);
  return {
    name: 'ap2',
    descriptor: {
      name: 'ap2',
      kind: 'authorization',
      implementationVersion: '0',
      supportedSpec: 't',
    },
    requirement: { method: 'ap2', version: '0.2.0', profile: 'test' },
    verifyAndReserve: vi.fn(),
    consume: finalize('consume'),
    release: finalize('release'),
    markUncertain: finalize('markUncertain'),
    health: async () => ({ status: 'pass', checkedAt: NOW }),
  } as unknown as AuthorizationProvider;
}

async function gateway(
  options: { token?: string | undefined; allowedOrigins?: string[] } = { token: TOKEN },
) {
  const base = makeGatewayConfig();
  const instance = await createGateway({
    config: makeGatewayConfig({
      server: {
        ...base.server,
        ...(options.token !== undefined ? { adminToken: options.token } : {}),
        allowedOrigins: options.allowedOrigins ?? [],
      },
    }),
    store,
    paymentProviders: [],
    authorizationProviders: [ap2Provider()],
    protocolAdapters: [],
    backend: { execute: vi.fn() } as unknown as BackendExecutor,
    logger: NOOP_LOGGER,
    clock: clockAt(NOW),
  });
  gateways.push(instance);
  return instance;
}

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

async function get(
  instance: GatewayInstance,
  url: string,
  headers: Record<string, string> = auth(),
) {
  return instance.server.inject({ method: 'GET', url, headers });
}

async function resolve(
  instance: GatewayInstance,
  attemptId: string,
  payload: unknown,
  headers: Record<string, string> = auth(),
  query = '',
) {
  return instance.server.inject({
    method: 'POST',
    url: `/api/payment-attempts/${attemptId}/resolve${query}`,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

// Journal rows created one minute apart, newest last
async function seed(
  n: number,
  options: {
    status?: 'settlement-uncertain' | 'settled';
    mandate?: boolean;
    expiresAt?: string;
  } = {},
) {
  storeTime = Date.parse(T0) + (n - 1) * 60_000;
  const reference = `sha256:M${n}`;
  const reservation: PaymentAttemptReservation = {
    requestId: `req_${n}`,
    resourceId: 'resource.report',
    provider: 'x402',
    replayKey: `replay_${n}`,
    amount: '0.01',
    currency: 'USDC',
    transaction: {
      id: `txn_${n}`,
      protocol: 'http',
      configDigest: 'sha256:0',
      // A secret-shaped key is redacted even in a locator's public metadata
      locator: { v: 1, network: 'eip155:84532', nonce: `0x${n}`, signature: '0xsecret' },
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.mandate === true
        ? {
            authorization: {
              method: 'ap2',
              reference,
              reservationId: reference,
              metadata: { mandateIssuer: 'https://trusted.example', token: 'jwt-secret' },
            },
          }
        : {}),
    },
  };
  const attempt = await store.reservePaymentAttempt(reservation);
  await store.updatePaymentAttempt({
    replayKey: attempt.replayKey,
    status: options.status ?? 'settlement-uncertain',
  });
  if (options.mandate === true) {
    replay.reserve({
      reference,
      checkoutJti: `checkout_${n}`,
      mandateIssuer: 'https://trusted.example',
      checkoutIssuer: 'https://merchant.example',
      resourceId: 'resource.report',
      requestId: `req_${n}`,
    });
    replay.markUncertain(reference);
  }
  return { attempt, reference };
}

const RESOLVE_BODY = { status: 'settled', actor: 'alice@ops', reason: 'found the transfer' };

describe('operator route access', () => {
  it('answers 404 on every route when no admin token is configured', async () => {
    const { attempt } = await seed(1);
    const closed = await gateway({ token: undefined });

    expect((await get(closed, '/api/transactions', {})).statusCode).toBe(404);
    expect((await get(closed, '/api/transactions/txn_1', {})).statusCode).toBe(404);
    expect((await resolve(closed, attempt.id, RESOLVE_BODY, {})).statusCode).toBe(404);
    expect((await store.getPaymentAttempt?.(attempt.id))?.resolution).toBeUndefined();
  });

  it.each([
    ['no token', {}],
    ['a wrong token', auth('not-the-token')],
    ['a token in the query string', {}],
  ])('answers 401 with %s and writes nothing', async (label, headers) => {
    const { attempt } = await seed(1);
    const instance = await gateway();
    const query = label === 'a token in the query string' ? `?token=${TOKEN}` : '';

    expect((await get(instance, `/api/transactions${query}`, headers)).statusCode).toBe(401);
    expect((await get(instance, `/api/transactions/txn_1${query}`, headers)).statusCode).toBe(401);
    expect((await resolve(instance, attempt.id, RESOLVE_BODY, headers, query)).statusCode).toBe(
      401,
    );
    expect((await store.getPaymentAttempt?.(attempt.id))?.resolution).toBeUndefined();
  });

  it('refuses a disallowed Origin with 403 even with the token', async () => {
    const { attempt } = await seed(1);
    const instance = await gateway({ token: TOKEN, allowedOrigins: ['https://dash.example'] });
    const headers = { ...auth(), origin: 'https://evil.example' };

    expect((await get(instance, '/api/transactions', headers)).statusCode).toBe(403);
    expect((await resolve(instance, attempt.id, RESOLVE_BODY, headers)).statusCode).toBe(403);
    expect((await store.getPaymentAttempt?.(attempt.id))?.resolution).toBeUndefined();

    const allowed = await get(instance, '/api/transactions', {
      ...auth(),
      origin: 'https://dash.example',
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('GET /api/transactions', () => {
  it('lists newest first with the age and the state computed now, redacted', async () => {
    await seed(1);
    await seed(2, { status: 'settled' });
    const instance = await gateway();

    const res = await get(instance, '/api/transactions');

    expect(res.statusCode).toBe(200);
    const { transactions, nextCursor } = res.json();
    expect(nextCursor).toBeUndefined();
    expect(
      transactions.map((t: { id: string; state: string; ageSeconds: number }) => [
        t.id,
        t.state,
        t.ageSeconds,
      ]),
    ).toEqual([
      // Created at 12:01 and 12:00, read at 12:30
      ['txn_2', 'settled-undelivered', 1740],
      ['txn_1', 'payment-uncertain', 1800],
    ]);
    expect(transactions[0].payment.locator).toEqual({
      v: 1,
      network: 'eip155:84532',
      nonce: '0x2',
      signature: '[REDACTED]',
    });
    expect(res.body).not.toContain('0xsecret');
  });

  it('filters by unresolved, state and requestId', async () => {
    await seed(1);
    await seed(2, { status: 'settled' });
    await store.recordTransactionStep?.({
      transactionId: 'txn_2',
      at: T0,
      kind: 'backend-dispatched',
      deadlineAt: T0,
    });
    await store.recordTransactionStep?.({
      transactionId: 'txn_2',
      at: T0,
      kind: 'backend-result',
      status: 200,
    });
    await store.recordTransactionStep?.({ transactionId: 'txn_2', at: T0, kind: 'completed' });
    await seed(3);
    const instance = await gateway();
    const ids = async (query: string) =>
      (await get(instance, `/api/transactions?${query}`))
        .json()
        .transactions.map((t: { id: string }) => t.id);

    expect(await ids('unresolved=true')).toEqual(['txn_3', 'txn_1']);
    expect(await ids('state=delivered')).toEqual(['txn_2']);
    expect(await ids('requestId=req_1')).toEqual(['txn_1']);
    // A repeated parameter takes its first value
    expect(await ids('requestId=req_3&requestId=req_1')).toEqual(['txn_3']);
    expect(await ids('unresolved=false')).toEqual(['txn_3', 'txn_2', 'txn_1']);
  });

  it('pages with the cursor until no cursor is returned', async () => {
    await seed(1);
    await seed(2);
    await seed(3);
    const instance = await gateway();

    const first = (await get(instance, '/api/transactions?limit=2')).json();
    const second = (
      await get(instance, `/api/transactions?limit=2&cursor=${first.nextCursor}`)
    ).json();

    expect(first.transactions.map((t: { id: string }) => t.id)).toEqual(['txn_3', 'txn_2']);
    expect(second.transactions.map((t: { id: string }) => t.id)).toEqual(['txn_1']);
    expect(second.nextCursor).toBeUndefined();
  });

  it.each([
    'cursor=abc',
    'cursor=0',
    'cursor=-1',
    'cursor=1%20OR%201%3D1',
    'cursor=99999999999999999',
    'state=lost',
    'unresolved=yes',
    'limit=0',
  ])('answers INPUT_INVALID for %s', async (query) => {
    await seed(1);
    const instance = await gateway();

    const res = await get(instance, `/api/transactions?${query}`);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INPUT_INVALID');
  });
});

describe('GET /api/transactions/:id', () => {
  it('returns the transaction with its attempt, receipt and events', async () => {
    const { attempt } = await seed(1, { status: 'settled', mandate: true });
    await store.saveReceipt(
      makeReceipt({ id: 'rcpt_1', requestId: 'req_1', resourceId: 'resource.report' }),
    );
    await store.recordTransactionStep?.({
      transactionId: 'txn_1',
      at: T0,
      kind: 'receipt',
      receiptId: 'rcpt_1',
    });
    await store.appendEvent(makeEvent({ id: 'evt_1', requestId: 'req_1', at: T0 }));
    await store.appendEvent(makeEvent({ id: 'evt_2', requestId: 'req_2', at: T0 }));
    const instance = await gateway();

    const res = await get(instance, '/api/transactions/txn_1');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction).toMatchObject({ id: 'txn_1', receiptId: 'rcpt_1', ageSeconds: 1800 });
    expect(body.transaction.authorization.metadata).toEqual({
      mandateIssuer: 'https://trusted.example',
      token: '[REDACTED]',
    });
    expect(body.attempt).toMatchObject({ id: attempt.id, status: 'settled' });
    expect(body.receipt).toMatchObject({ id: 'rcpt_1' });
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(['evt_1']);
    expect(res.body).not.toContain('jwt-secret');
  });

  it('omits the receipt of a transaction that has none', async () => {
    const { attempt } = await seed(1);
    const instance = await gateway();

    const body = (await get(instance, '/api/transactions/txn_1')).json();

    expect(Object.keys(body).sort()).toEqual(['attempt', 'events', 'transaction']);
    expect(body.attempt.id).toBe(attempt.id);
    expect(body.events).toEqual([]);
  });

  it('answers 404 RESOURCE_NOT_FOUND for an unknown transaction', async () => {
    const instance = await gateway();

    const res = await get(instance, '/api/transactions/txn_missing');

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 500 STORAGE_ERROR when the store has no journal', async () => {
    const { listTransactions: _l, getTransaction: _g, ...withoutJournal } = store;
    store = withoutJournal as ReceiptStore;
    const instance = await gateway();

    for (const url of ['/api/transactions', '/api/transactions/txn_1']) {
      const res = await get(instance, url);
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('STORAGE_ERROR');
    }
  });
});

describe('POST /api/payment-attempts/:id/resolve', () => {
  it('resolves an attempt, aligns its hold, and answers 409 the second time', async () => {
    const { attempt, reference } = await seed(1, { mandate: true });
    const instance = await gateway();

    const res = await resolve(instance, attempt.id, {
      ...RESOLVE_BODY,
      externalReference: '0xfeed',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      attempt: expect.objectContaining({
        id: attempt.id,
        status: 'settled',
        resolution: {
          method: 'manual',
          actor: 'alice@ops',
          reason: 'found the transfer',
          at: NOW,
          externalReference: '0xfeed',
        },
      }),
      hold: {
        transactionId: 'txn_1',
        attemptId: attempt.id,
        method: 'ap2',
        hold: 'consumed',
        written: true,
      },
    });
    expect(replay.stateOf(reference)).toBe('consumed');

    const again = await resolve(instance, attempt.id, RESOLVE_BODY);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      status: 'error',
      code: 'INPUT_INVALID',
      message: 'The payment attempt already has a resolution',
      retryable: false,
      details: { reason: 'already_resolved', attemptStatus: 'settled' },
    });
  });

  it('answers 409 not_expired while the authorization can still land', async () => {
    const { attempt } = await seed(1, { expiresAt: '2026-10-28T13:00:00.000Z' });
    const instance = await gateway();

    const res = await resolve(instance, attempt.id, { ...RESOLVE_BODY, status: 'rejected' });

    expect(res.statusCode).toBe(409);
    expect(res.json().details).toEqual({
      reason: 'not_expired',
      attemptStatus: 'settlement-uncertain',
    });
  });

  it('rejects an attempt with no recorded expiry once confirmed', async () => {
    const { attempt } = await seed(1);
    const instance = await gateway();
    const body = { ...RESOLVE_BODY, status: 'rejected' };

    expect((await resolve(instance, attempt.id, body)).json().details.reason).toBe(
      'expiry_unknown',
    );
    const confirmed = await resolve(instance, attempt.id, { ...body, confirmExpired: true });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().attempt.status).toBe('rejected');
  });

  it.each([
    ['an array body', []],
    ['a string body', '"settled"'],
    ['an unknown field', { ...RESOLVE_BODY, amount: '0' }],
    ['a missing status', { actor: 'alice@ops', reason: 'x' }],
    ['a missing actor', { status: 'settled', reason: 'x' }],
    ['a numeric reason', { ...RESOLVE_BODY, reason: 1 }],
    ['a string confirmExpired', { ...RESOLVE_BODY, confirmExpired: 'true' }],
    ['an unknown status', { ...RESOLVE_BODY, status: 'refunded' }],
  ])('answers 400 INPUT_INVALID for %s and writes nothing', async (_label, payload) => {
    const { attempt } = await seed(1);
    const instance = await gateway();

    const res = await resolve(instance, attempt.id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INPUT_INVALID');
    expect((await store.getPaymentAttempt?.(attempt.id))?.resolution).toBeUndefined();
  });

  it('answers 413 for a body over 4 KiB and writes nothing', async () => {
    const { attempt } = await seed(1);
    const instance = await gateway();
    const payload = JSON.stringify({ ...RESOLVE_BODY, reason: 'r'.repeat(4096) });

    const res = await resolve(instance, attempt.id, payload);

    expect(res.statusCode).toBe(413);
    expect((await store.getPaymentAttempt?.(attempt.id))?.resolution).toBeUndefined();
  });

  it('answers 404 RESOURCE_NOT_FOUND for an unknown attempt', async () => {
    const instance = await gateway();

    const res = await resolve(instance, 'pa_missing', RESOLVE_BODY);

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('RESOURCE_NOT_FOUND');
  });
});
