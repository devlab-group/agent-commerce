/**
 * Test pending x402 tasks with the gateway, pipeline, A2A adapter and SQLite
 * store. Payment and authorization providers are fakes, and the backend is a
 * stub. Simulate a restart by opening a new store and gateway on the same file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../../src/config';
import type {
  AdapterDescriptor,
  AuthorizationProvider,
  AuthorizationSubmission,
  Clock,
  IdGenerator,
  Logger,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentVerificationContext,
  ReceiptStore,
} from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { type A2aAdapterOptions, createA2aAdapter } from '../../../src/protocols/a2a';
import type { A2aTask } from '../../../src/protocols/a2a/types';
import {
  A2A_X402_EXTENSION_URI,
  createStoredPendingPayments,
} from '../../../src/protocols/a2a/x402-extension';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

const DESCRIPTOR: AdapterDescriptor = {
  name: 'fake',
  kind: 'payment',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'n/a',
  capabilities: [],
  status: 'experimental',
};

const MANDATE: AuthorizationSubmission = { method: 'ap2', payload: 'mandate-payload~disclosure~' };
const START = Date.parse('2026-10-05T00:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Reads do not tick, so expiry moves only when a test says so
function createClock() {
  let now = START;
  const clock: Clock = {
    now: () => new Date(now),
    nowIso: () => new Date(now).toISOString(),
    monotonicMs: () => now,
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
    },
  };
}

// Counts what the pipeline asked of each provider, across restarts
interface Calls {
  verify: number;
  settle: number;
  mandates: AuthorizationSubmission[];
}

function fakePayments(clock: Clock, calls: Calls): PaymentProvider {
  const result = (
    ctx: PaymentVerificationContext,
    status: 'verified' | 'settled',
  ): PaymentResult => ({
    status,
    provider: 'x402',
    amount: ctx.requirement.amount,
    currency: ctx.requirement.currency,
    // One key per proof, so a replay of the same proof is the only collision
    replayKey: `replay:${ctx.submission.payload}`,
    ...(status === 'settled' ? { externalReference: '0xTXHASH' } : {}),
  });
  return {
    name: 'x402',
    descriptor: DESCRIPTOR,
    async createRequirement(ctx: PaymentContext): Promise<PaymentRequirement> {
      return {
        id: `requirement-${ctx.requestId}`,
        requestId: ctx.requestId,
        resourceId: ctx.resource.id,
        provider: 'x402',
        amount: ctx.amount,
        currency: ctx.currency,
        destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        network: 'eip155:31337',
        expiresAt: new Date(clock.now().getTime() + 5 * MINUTE).toISOString(),
        challenge: {
          provider: 'x402',
          version: '2',
          accepts: [{ scheme: 'exact' }],
          envelope: { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:31337' }] },
        },
      };
    },
    async verify(ctx) {
      calls.verify += 1;
      return result(ctx, 'verified');
    },
    async settle(ctx) {
      calls.settle += 1;
      return result(ctx, 'settled');
    },
    health: async () => ({ status: 'pass', checkedAt: clock.nowIso() }),
  };
}

function fakeMandates(clock: Clock, calls: Calls): AuthorizationProvider {
  return {
    name: 'ap2',
    descriptor: { ...DESCRIPTOR, kind: 'authorization' },
    requirement: { method: 'ap2', version: 'v0.2.0' },
    async verifyAndReserve(ctx) {
      calls.mandates.push(ctx.submission);
      return {
        status: 'verified',
        method: 'ap2',
        reference: 'digest',
        reservationId: `reservation-${calls.mandates.length}`,
      };
    },
    async consume() {},
    async release() {},
    async markUncertain() {},
    health: async () => ({ status: 'pass', checkedAt: clock.nowIso() }),
  };
}

function config(): GatewayConfig {
  const base = {
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
    handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    exposedVia: ['a2a'],
    paymentMethods: ['x402'],
  } as const;
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: false },
      mcp: { enabled: false, mountPath: '/mcp' },
      a2a: { enabled: true, mountPath: '/a2a' },
      acp: { enabled: false, mountPath: '/acp' },
    },
    resources: [
      { ...base, id: 'report', name: 'Report' },
      { ...base, id: 'mandated', name: 'Mandated', authorization: { required: ['ap2'] } },
    ],
    payments: {},
  };
}

interface Node {
  readonly store: ReceiptStore;
  readonly gateway: GatewayInstance;
}

interface JsonRpc {
  readonly result?: { task: A2aTask };
  readonly error?: { code: number; message: string; data?: Record<string, unknown>[] };
}

let dir: string;
let path: string;
let calls: Calls;
let backendCalls: number;
let time: ReturnType<typeof createClock>;
let ids: IdGenerator;
// Set to hold every backend call until it resolves
let backendGate: Promise<void> | undefined;
// Release the backend gate so teardown can finish waiting for background work
let releaseBackend: () => void;
let open: Node[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a2a-pending-store-'));
  path = join(dir, 'receipts.db');
  calls = { verify: 0, settle: 0, mandates: [] };
  backendCalls = 0;
  backendGate = undefined;
  releaseBackend = () => {};
  time = createClock();
  // Keep test IDs distinct across gateway restarts
  let n = 0;
  ids = { next: (prefix) => `${prefix ?? 'id'}-${++n}` };
  open = [];
});

afterEach(async () => {
  releaseBackend();
  for (const node of open) await shutdown(node);
  rmSync(dir, { recursive: true, force: true });
});

// The adapter's store defaults to the gateway's own
async function boot(
  adapterStore?: (store: ReceiptStore) => ReceiptStore,
  tasks?: A2aAdapterOptions['tasks'],
): Promise<Node> {
  const store = createSqliteReceiptStore({ path, clock: time.clock, ids, logger: NOOP_LOGGER });
  await store.init();
  const gateway = await createGateway({
    config: config(),
    store,
    paymentProviders: [fakePayments(time.clock, calls)],
    authorizationProviders: [fakeMandates(time.clock, calls)],
    protocolAdapters: [
      createA2aAdapter({ store: adapterStore?.(store) ?? store, ...(tasks ? { tasks } : {}) }),
    ],
    logger: NOOP_LOGGER,
    clock: time.clock,
    ids,
    backend: {
      async call() {
        backendCalls += 1;
        await backendGate;
        return { status: 200, body: { report: 'paid' }, headers: {}, durationMs: 1 };
      },
    },
  });
  const node = { store, gateway };
  open.push(node);
  return node;
}

// The adapter never closes the store, so the test closes both
async function shutdown(node: Node): Promise<void> {
  open = open.filter((candidate) => candidate !== node);
  await node.gateway.close();
  await node.store.close();
}

interface Answer {
  // `{ task }` from SendMessage, a task from GetTask and CancelTask, a page from ListTasks
  readonly result?: Partial<A2aTask> & { readonly task?: A2aTask; readonly tasks?: A2aTask[] };
  readonly error?: { code: number; message: string };
}

async function call(node: Node, method: string, params: Record<string, unknown>): Promise<Answer> {
  const res = await node.gateway.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method, params }),
  });
  return res.json();
}

async function rpc(
  node: Node,
  message: Record<string, unknown>,
  configuration?: Record<string, unknown>,
): Promise<JsonRpc> {
  const res = await node.gateway.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      'a2a-extensions': A2A_X402_EXTENSION_URI,
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: { message, ...(configuration ? { configuration } : {}) },
    }),
  });
  return res.json();
}

function buy(resource: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'ROLE_USER',
    messageId: 'msg-buy',
    parts: [
      { data: { resource, input: { symbol: 'ETH', ...input } }, mediaType: 'application/json' },
    ],
  };
}

async function challenged(node: Node, resource: string, input?: Record<string, unknown>) {
  const { result } = await rpc(node, buy(resource, input));
  expect(result?.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  return result?.task as A2aTask;
}

function pay(
  task: A2aTask,
  nonce = 'nonce-1',
  parts: Record<string, unknown>[] = [{ text: 'Here is the payment.' }],
): Record<string, unknown> {
  return {
    role: 'ROLE_USER',
    messageId: `msg-pay-${nonce}`,
    taskId: task.id,
    contextId: task.contextId,
    parts,
    metadata: {
      'x402.payment.status': 'payment-submitted',
      'x402.payment.payload': { x402Version: 2, nonce },
    },
  };
}

function decline(task: A2aTask): Record<string, unknown> {
  return {
    role: 'ROLE_USER',
    messageId: 'msg-decline',
    taskId: task.id,
    contextId: task.contextId,
    parts: [{ text: 'No thanks.' }],
    metadata: { 'x402.payment.status': 'payment-rejected' },
  };
}

const TASK_NOT_FOUND = -32001;
// A message on a recorded task that is no longer waiting for payment
const NO_FURTHER_MESSAGES = -32004;

describe('a task waiting for payment, held in the receipt store', () => {
  it('is paid after a restart, and the purchase settles once', async () => {
    const first = await boot();
    const task = await challenged(first, 'report');
    await shutdown(first);

    const second = await boot();
    const { result } = await rpc(second, pay(task));

    expect(result?.task).toMatchObject({ id: task.id, contextId: task.contextId });
    expect(result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(result?.task.artifacts[0]?.parts[0]?.data).toEqual({ report: 'paid' });
    expect(calls).toMatchObject({ verify: 1, settle: 1 });
    expect(backendCalls).toBe(1);
    expect(await second.store.listPaymentAttempts()).toEqual([
      expect.objectContaining({ status: 'settled' }),
    ]);

    // The payment consumed the task
    const again = await rpc(second, pay(task, 'nonce-2'));
    expect(again.error?.code).toBe(NO_FURTHER_MESSAGES);
    expect(calls.settle).toBe(1);
  });

  it('runs one purchase when two payment messages both passed the check', async () => {
    const node = await boot((store) => {
      const waiting: (() => void)[] = [];
      let open = false;
      // Holds the first two reads until both messages have one, so neither can
      // have taken the task yet. Later reads pass, so a fault fails fast.
      const gated = Object.create(store) as ReceiptStore;
      gated.getPendingTask = async (id) => {
        const task = await store.getPendingTask?.(id);
        if (!open) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 2) {
              open = true;
              for (const release of waiting) release();
            }
          });
        }
        return task;
      };
      return gated;
    });
    const task = await challenged(node, 'report');

    const answers = await Promise.all([
      rpc(node, pay(task, 'nonce-a')),
      rpc(node, pay(task, 'nonce-b')),
    ]);

    const paid = answers.filter((answer) => answer.result !== undefined);
    const missing = answers.filter((answer) => answer.error?.code === NO_FURTHER_MESSAGES);
    expect(paid).toHaveLength(1);
    expect(paid[0]?.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(missing).toHaveLength(1);
    expect(calls).toMatchObject({ verify: 1, settle: 1 });
    expect(backendCalls).toBe(1);
    expect(await node.store.listPaymentAttempts()).toHaveLength(1);
  });

  it('stays in the store, still open, when the adapter stops', async () => {
    const node = await boot();
    const task = await challenged(node, 'report');

    await node.gateway.close();

    expect((await node.store.health()).status).toBe('pass');
    expect(await node.store.getPendingTask?.(task.id)).toBeDefined();
  });

  it('is deleted when the client declines to pay', async () => {
    const node = await boot();
    const task = await challenged(node, 'report');

    const { result } = await rpc(node, decline(task));

    expect(result?.task.status).toMatchObject({
      state: 'TASK_STATE_FAILED',
      message: { metadata: { 'x402.payment.status': 'payment-rejected' } },
    });
    expect(await node.store.getPendingTask?.(task.id)).toBeUndefined();
    const later = await rpc(node, pay(task));
    expect(later.error?.code).toBe(NO_FURTHER_MESSAGES);
    expect(calls).toMatchObject({ verify: 0, settle: 0 });
  });

  it('is gone once its requirement expires', async () => {
    const node = await boot();
    const task = await challenged(node, 'report');

    time.advance(5 * MINUTE);

    const { error } = await rpc(node, pay(task));
    expect(error?.code).toBe(TASK_NOT_FOUND);
    expect(calls.verify).toBe(0);
    // Its record expires with it, which leaves nothing that looks payable
    expect((await call(node, 'GetTask', { id: task.id })).error?.code).toBe(TASK_NOT_FOUND);
  });

  it('stays payable after a malformed payment message', async () => {
    const node = await boot();
    const task = await challenged(node, 'report');

    const malformed = await rpc(node, {
      ...pay(task),
      metadata: { 'x402.payment.status': 'payment-submitted' },
    });
    expect(malformed.error?.code).toBe(-32602);

    const { result } = await rpc(node, pay(task));
    expect(result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('stores neither the mandate nor a payment proof', async () => {
    const node = await boot();
    const task = await challenged(node, 'mandated', { _authorization: MANDATE });

    const stored = await node.store.getPendingTask?.(task.id);
    expect(stored).toMatchObject({
      protocol: 'a2a',
      resourceId: 'mandated',
      input: { symbol: 'ETH' },
      adapterData: { contextId: task.contextId, network: 'eip155:31337' },
    });

    const db = new Database(path, { readonly: true });
    try {
      const rows = JSON.stringify(db.prepare('SELECT * FROM pending_tasks').all());
      expect(rows).toContain(task.id);
      for (const secret of [MANDATE.payload, '_authorization', '_payment', 'authorization']) {
        expect(rows).not.toContain(secret);
      }
    } finally {
      db.close();
    }
  });

  describe('with a mandate', () => {
    it('keeps the mandate in memory, so the same process pays without resending it', async () => {
      const node = await boot();
      const task = await challenged(node, 'mandated', { _authorization: MANDATE });

      const { result } = await rpc(node, pay(task));

      expect(result?.task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(calls.mandates).toEqual([MANDATE]);
    });

    it('is paid after a restart only when the payment message carries the mandate', async () => {
      const first = await boot();
      const without = await challenged(first, 'mandated', { _authorization: MANDATE });
      const withIt = await challenged(first, 'mandated', { _authorization: MANDATE });
      await shutdown(first);
      const second = await boot();

      const refused = await rpc(second, pay(without, 'nonce-a'));
      expect(refused.result?.task.status.state).toBe('TASK_STATE_FAILED');
      expect(refused.result?.task.artifacts[0]?.parts[0]?.data).toMatchObject({
        code: 'AUTHORIZATION_REQUIRED',
      });
      expect(await second.store.listPaymentAttempts()).toEqual([]);
      expect(calls).toMatchObject({ settle: 0, mandates: [] });
      expect(backendCalls).toBe(0);

      const resent = { ...MANDATE, payload: 'resent-mandate~' };
      const accepted = await rpc(
        second,
        pay(withIt, 'nonce-b', [
          { text: 'Payment and mandate.' },
          {
            data: { resource: 'mandated', input: { _authorization: resent } },
            mediaType: 'application/json',
          },
        ]),
      );
      expect(accepted.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(calls.mandates).toEqual([resent]);
      expect(calls.settle).toBe(1);
      expect(await second.store.listPaymentAttempts()).toHaveLength(1);
    });
  });
});

// Neither group: pending tasks and answered tasks both live in memory
const memoryOnly = (store: ReceiptStore): ReceiptStore =>
  Object.assign(Object.create(store) as ReceiptStore, {
    putPendingTask: undefined,
    getPendingTask: undefined,
    takePendingTask: undefined,
    putTaskRecord: undefined,
    getTaskRecord: undefined,
    listTaskRecords: undefined,
  });

describe('answered tasks, kept in the receipt store', () => {
  it('reads a paid task after a restart, until its retention ends', async () => {
    const first = await boot();
    const task = await challenged(first, 'report');
    const paid = (await rpc(first, pay(task))).result?.task;
    await shutdown(first);
    const second = await boot();

    expect((await call(second, 'GetTask', { id: task.id })).result).toEqual(paid);
    time.advance(24 * HOUR - 1);
    expect((await call(second, 'GetTask', { id: task.id })).result).toEqual(paid);
    time.advance(1);
    expect((await call(second, 'GetTask', { id: task.id })).error?.code).toBe(TASK_NOT_FOUND);
    expect((await call(second, 'ListTasks', { contextId: task.contextId })).result).toEqual({
      tasks: [],
      nextPageToken: '',
      pageSize: 50,
      totalSize: 0,
    });
  });

  it('keeps a task for the configured retention', async () => {
    const node = await boot(undefined, { retentionHours: 1 });
    const task = await challenged(node, 'report');
    await rpc(node, pay(task));

    time.advance(HOUR - 1);
    expect((await call(node, 'GetTask', { id: task.id })).result?.status?.state).toBe(
      'TASK_STATE_COMPLETED',
    );
    time.advance(1);
    expect((await call(node, 'GetTask', { id: task.id })).error?.code).toBe(TASK_NOT_FOUND);
  });

  it('reads as working while its payment runs, then as its result', async () => {
    const node = await boot();
    const task = await challenged(node, 'report');
    let release = () => {};
    backendGate = new Promise((resolve) => {
      release = resolve;
    });

    const paying = rpc(node, pay(task));
    await vi.waitFor(async () => {
      const read = await call(node, 'GetTask', { id: task.id });
      expect(read.result?.status?.state).toBe('TASK_STATE_WORKING');
    });
    const working = await call(node, 'ListTasks', {
      contextId: task.contextId,
      status: 'TASK_STATE_WORKING',
    });
    const cancel = await call(node, 'CancelTask', { id: task.id });
    release();
    const paid = (await paying).result?.task;

    expect(working.result?.tasks?.map((listed) => listed.id)).toEqual([task.id]);
    expect(cancel.error?.code).toBe(-32002);
    expect(paid?.status.state).toBe('TASK_STATE_COMPLETED');
    expect((await call(node, 'GetTask', { id: task.id })).result).toEqual(paid);
    expect(calls.settle).toBe(1);
  });

  it('answers an internal error when the canceled task cannot be recorded, and stays canceled', async () => {
    let failPuts = false;
    const node = await boot((store) =>
      Object.assign(Object.create(store) as ReceiptStore, {
        async putTaskRecord(...args: Parameters<NonNullable<ReceiptStore['putTaskRecord']>>) {
          if (failPuts) throw new Error('disk full');
          return store.putTaskRecord?.(...args) ?? false;
        },
      }),
    );
    const task = await challenged(node, 'report');
    failPuts = true;

    const cancel = await call(node, 'CancelTask', { id: task.id });
    const payment = await rpc(node, pay(task));

    expect(cancel).toMatchObject({ id: 'req-1', error: { code: -32603 } });
    expect(await node.store.getPendingTask?.(task.id)).toBeUndefined();
    expect(payment.error?.code).toBe(NO_FURTHER_MESSAGES);
    expect(calls.verify).toBe(0);
  });

  it('refuses a purchase when the task store is full, and holds nothing for it', async () => {
    const node = await boot(undefined, { maxRetained: 1 });
    const waiting = await challenged(node, 'report');

    const { result } = await rpc(node, buy('report'));

    const busy = result?.task as A2aTask;
    expect(busy.status.state).toBe('TASK_STATE_FAILED');
    expect(busy.artifacts[0]?.parts[0]?.data).toMatchObject({ code: 'GATEWAY_BUSY' });
    expect(await node.store.getPendingTask?.(busy.id)).toBeUndefined();
    expect((await call(node, 'GetTask', { id: busy.id })).error?.code).toBe(TASK_NOT_FOUND);
    // The waiting task replaces its own record, which always fits
    const paid = await rpc(node, pay(waiting));
    expect(paid.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('keeps no payment proof, mandate or request input in any task record', async () => {
    const node = await boot();
    const input = { _authorization: MANDATE, note: 'private-input' };
    const paid = await challenged(node, 'mandated', input);
    const declined = await challenged(node, 'mandated', input);
    const canceled = await challenged(node, 'mandated', input);
    await rpc(node, pay(paid, 'secret-nonce'));
    await rpc(node, decline(declined));
    await call(node, 'CancelTask', { id: canceled.id });

    const db = new Database(path, { readonly: true });
    try {
      const rows = db.prepare('SELECT id, state, document_json FROM task_records').all() as {
        id: string;
        state: string;
      }[];
      expect(rows.map((row) => [row.id, row.state]).sort()).toEqual(
        [
          [paid.id, 'TASK_STATE_COMPLETED'],
          [declined.id, 'TASK_STATE_FAILED'],
          [canceled.id, 'TASK_STATE_CANCELED'],
        ].sort(),
      );
      const text = JSON.stringify(rows);
      for (const secret of [
        MANDATE.payload,
        '_authorization',
        '_payment',
        'secret-nonce',
        'x402.payment.payload',
        'private-input',
      ]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      db.close();
    }
  });

  it.each([
    ['SQLite', undefined],
    ['memory', memoryOnly],
  ])(
    'lets one of eight racing cancel and payment messages take a task, in %s',
    async (_label, wrap) => {
      const node = await boot(wrap);
      const task = await challenged(node, 'report');

      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0
            ? call(node, 'CancelTask', { id: task.id })
            : (rpc(node, pay(task, `nonce-${i}`)) as Promise<Answer>),
        ),
      );

      const paid = answers.filter((a) => a.result?.task?.status.state === 'TASK_STATE_COMPLETED');
      const canceled = answers.filter((a) => a.result?.status?.state === 'TASK_STATE_CANCELED');
      const refused = answers.filter((a) => a.error?.code === -32002 || a.error?.code === -32004);
      expect(paid.length).toBeLessThanOrEqual(1);
      // A cancel and a payment never both succeed
      expect(paid.length * canceled.length).toBe(0);
      expect(paid.length + canceled.length + refused.length).toBe(8);
      expect(calls).toMatchObject({ verify: paid.length, settle: paid.length });
      expect(backendCalls).toBe(paid.length);
      expect((await call(node, 'GetTask', { id: task.id })).result?.status?.state).toBe(
        paid.length === 1 ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_CANCELED',
      );
    },
  );
});

// Block backend calls until the returned release function is called
function holdBackend(): () => void {
  backendGate = new Promise((resolve) => {
    releaseBackend = resolve;
  });
  return releaseBackend;
}

const IMMEDIATELY = { returnImmediately: true };

// Submit a purchase with its proof and returnImmediately, without the x402 extension
function buyNow(node: Node, proof: string, resource = 'report'): Promise<Answer> {
  return call(node, 'SendMessage', {
    message: buy(resource, { _payment: proof }),
    configuration: IMMEDIATELY,
  });
}

async function stateOf(node: Node, id: string): Promise<string | undefined> {
  return (await call(node, 'GetTask', { id })).result?.status?.state;
}

function code(task: A2aTask | undefined): unknown {
  return (task?.artifacts[0]?.parts[0]?.data as Record<string, unknown> | undefined)?.['code'];
}

describe('tasks finished in the background with returnImmediately', () => {
  it('answers a working task before the backend returns, then records the result', async () => {
    const node = await boot();
    const release = holdBackend();

    const working = (await buyNow(node, 'proof-1')).result?.task as A2aTask;

    expect(working).toEqual({
      id: working.id,
      contextId: working.contextId,
      status: { state: 'TASK_STATE_WORKING', timestamp: time.clock.nowIso() },
      artifacts: [],
    });
    await vi.waitFor(() => expect(backendCalls).toBe(1));
    expect(await stateOf(node, working.id)).toBe('TASK_STATE_WORKING');
    release();
    await vi.waitFor(async () =>
      expect(await stateOf(node, working.id)).toBe('TASK_STATE_COMPLETED'),
    );
    const done = (await call(node, 'GetTask', { id: working.id })).result as A2aTask;
    expect(done.contextId).toBe(working.contextId);
    expect(done.artifacts[0]?.parts[0]?.data).toEqual({ report: 'paid' });
    expect(calls.settle).toBe(1);
  });

  it('records the failed task a blocking call would answer when the purchase fails', async () => {
    const node = await boot();
    const blocking = (
      await call(node, 'SendMessage', { message: buy('mandated', { _payment: 'proof-a' }) })
    ).result?.task;

    const working = (await buyNow(node, 'proof-b', 'mandated')).result?.task as A2aTask;

    expect(working.status.state).toBe('TASK_STATE_WORKING');
    await vi.waitFor(async () => expect(await stateOf(node, working.id)).toBe('TASK_STATE_FAILED'));
    const failed = (await call(node, 'GetTask', { id: working.id })).result as A2aTask;
    expect(blocking?.status.state).toBe('TASK_STATE_FAILED');
    expect(code(failed)).toBe(code(blocking));
    expect(backendCalls).toBe(0);
  });

  it('reaches input-required in the background, then is paid in the background', async () => {
    const node = await boot();
    const working = (await rpc(node, buy('report'), IMMEDIATELY)).result?.task as A2aTask;
    expect(working.status.state).toBe('TASK_STATE_WORKING');
    await vi.waitFor(async () =>
      expect(await stateOf(node, working.id)).toBe('TASK_STATE_INPUT_REQUIRED'),
    );
    const release = holdBackend();

    const paying = (await rpc(node, pay(working), IMMEDIATELY)).result?.task as A2aTask;

    expect(paying).toMatchObject({ id: working.id, status: { state: 'TASK_STATE_WORKING' } });
    await vi.waitFor(() => expect(backendCalls).toBe(1));
    expect(await stateOf(node, working.id)).toBe('TASK_STATE_WORKING');
    release();
    await vi.waitFor(async () =>
      expect(await stateOf(node, working.id)).toBe('TASK_STATE_COMPLETED'),
    );
    const paid = (await call(node, 'GetTask', { id: working.id })).result as A2aTask;
    expect(paid.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-completed',
    });
    expect(calls).toMatchObject({ verify: 1, settle: 1 });
  });

  it('refuses a 21st purchase or payment while 20 run in the background, and runs nothing for it', async () => {
    const node = await boot();
    const waiting = await challenged(node, 'report');
    const release = holdBackend();
    const running: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const answer = await buyNow(node, `proof-${i}`);
      running.push(answer.result?.task?.id as string);
    }
    await vi.waitFor(() => expect(backendCalls).toBe(20));

    const purchase = (await buyNow(node, 'proof-20')).result?.task;
    const payment = await rpc(node, pay(waiting), IMMEDIATELY);

    expect(purchase?.status.state).toBe('TASK_STATE_FAILED');
    expect(code(purchase)).toBe('GATEWAY_BUSY');
    expect((await call(node, 'GetTask', { id: purchase?.id })).error?.code).toBe(TASK_NOT_FOUND);
    // A system error, not a failed task: the task is not terminal
    expect(payment).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      error: {
        code: -32603,
        message: 'Too many tasks are running in the background; retry shortly.',
        data: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }],
      },
    });
    // Capacity refusal leaves the pending purchase and its retained response unchanged
    expect(await stateOf(node, waiting.id)).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(calls.verify).toBe(20);
    expect(backendCalls).toBe(20);

    release();
    for (const id of running) {
      await vi.waitFor(async () => expect(await stateOf(node, id)).toBe('TASK_STATE_COMPLETED'));
    }
    // Completed runs release their slots
    const retried = (await rpc(node, pay(waiting), IMMEDIATELY)).result?.task;
    expect(retried?.status.state).toBe('TASK_STATE_WORKING');
    await vi.waitFor(async () =>
      expect(await stateOf(node, waiting.id)).toBe('TASK_STATE_COMPLETED'),
    );
    expect(calls.settle).toBe(21);
  });

  it('refuses a purchase whose working task does not fit, runs nothing and keeps no slot', async () => {
    const node = await boot(undefined, { maxRetained: 1 });
    await buyNow(node, 'proof-1');
    await vi.waitFor(() => expect(calls.settle).toBe(1));

    // Repeated refusals must release their slot reservations
    for (let i = 0; i < 21; i += 1) {
      const refused = (await buyNow(node, `proof-${i + 2}`)).result?.task;
      expect(refused?.status.state).toBe('TASK_STATE_FAILED');
      expect(refused?.artifacts[0]?.parts[0]?.data).toMatchObject({
        code: 'GATEWAY_BUSY',
        message: 'Too many answered tasks are retained; retry shortly.',
      });
      expect((await call(node, 'GetTask', { id: refused?.id })).error?.code).toBe(TASK_NOT_FOUND);
    }
    expect(calls.verify).toBe(1);
  });

  it('reads as failed when a background run cannot record its result', async () => {
    const node = await boot((store) =>
      Object.assign(Object.create(store) as ReceiptStore, {
        async putTaskRecord(...args: Parameters<NonNullable<ReceiptStore['putTaskRecord']>>) {
          if (args[0].state === 'TASK_STATE_COMPLETED') throw new Error('disk full');
          return store.putTaskRecord?.(...args) ?? false;
        },
      }),
    );

    const working = (await buyNow(node, 'proof-1')).result?.task as A2aTask;

    await vi.waitFor(async () => expect(await stateOf(node, working.id)).toBe('TASK_STATE_FAILED'));
    const read = (await call(node, 'GetTask', { id: working.id })).result as A2aTask;
    expect(code(read)).toBe('INTERNAL_ERROR');
    expect(calls.settle).toBe(1);
  });

  it('answers a failed task and runs nothing when the working task cannot be written', async () => {
    let failPuts = false;
    const node = await boot((store) =>
      Object.assign(Object.create(store) as ReceiptStore, {
        async putTaskRecord(...args: Parameters<NonNullable<ReceiptStore['putTaskRecord']>>) {
          if (failPuts) throw new Error('disk full at /var/lib/receipts.db');
          return store.putTaskRecord?.(...args) ?? false;
        },
      }),
    );
    const waiting = await challenged(node, 'report');
    failPuts = true;

    const purchase = (await buyNow(node, 'proof-1')).result?.task;
    const payment = (await rpc(node, pay(waiting), IMMEDIATELY)).result?.task;

    for (const task of [purchase, payment]) {
      expect(task?.status.state).toBe('TASK_STATE_FAILED');
      expect(code(task)).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(task)).not.toContain('disk full');
    }
    expect(payment?.id).toBe(waiting.id);
    // The failed write follows the take, so the purchase is no longer pending
    expect(await node.store.getPendingTask?.(waiting.id)).toBeUndefined();
    expect(calls.verify).toBe(0);
    expect(backendCalls).toBe(0);
  });

  it('waits on stop for a background run, which records its result', async () => {
    const node = await boot();
    const release = holdBackend();
    const working = (await buyNow(node, 'proof-1')).result?.task as A2aTask;
    await vi.waitFor(() => expect(backendCalls).toBe(1));
    open = open.filter((candidate) => candidate !== node);

    let closed = false;
    const closing = node.gateway.close().then(() => {
      closed = true;
    });
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;

    const record = await node.store.getTaskRecord?.(working.id);
    await node.store.close();
    expect(record?.state).toBe('TASK_STATE_COMPLETED');
    expect(calls.settle).toBe(1);
  });

  it('reads a run another gateway stopped in as failed, and the same proof does not settle again', async () => {
    const first = await boot();
    const release = holdBackend();
    const working = (await buyNow(first, 'proof-1')).result?.task as A2aTask;
    await vi.waitFor(() => expect(backendCalls).toBe(1));

    // A second adapter has no local running entry, simulating a restart
    const second = await boot();
    const read = (await call(second, 'GetTask', { id: working.id })).result as A2aTask;
    const replay = (
      await call(second, 'SendMessage', { message: buy('report', { _payment: 'proof-1' }) })
    ).result?.task;

    expect(read.status.state).toBe('TASK_STATE_FAILED');
    expect(code(read)).toBe('INTERNAL_ERROR');
    expect(read.status.message?.parts[0]?.text).toContain(
      'check with the merchant before paying again',
    );
    expect(code(replay)).toBe('PAYMENT_REPLAYED');
    expect(backendCalls).toBe(1);
    release();
    await vi.waitFor(async () =>
      expect(await stateOf(first, working.id)).toBe('TASK_STATE_COMPLETED'),
    );
    expect(calls.settle).toBe(1);
  });
});

describe('a store without the pending-task methods', () => {
  const noTasks = (store: ReceiptStore): ReceiptStore =>
    Object.assign(Object.create(store) as ReceiptStore, {
      putPendingTask: undefined,
      getPendingTask: undefined,
      takePendingTask: undefined,
    });
  const putOnly = (store: ReceiptStore): ReceiptStore =>
    Object.assign(Object.create(store) as ReceiptStore, {
      getPendingTask: undefined,
      takePendingTask: undefined,
    });

  it.each([
    ['none of the group', noTasks],
    ['only part of the group', putOnly],
  ])('keeps tasks in memory with %s, which a restart loses', async (_label, wrap) => {
    const first = await boot(wrap);
    const task = await challenged(first, 'report');
    expect(await first.store.getPendingTask?.(task.id)).toBeUndefined();

    const sameProcess = await rpc(first, pay(task));
    expect(sameProcess.result?.task.status.state).toBe('TASK_STATE_COMPLETED');

    const lost = await challenged(first, 'report');
    await shutdown(first);
    const second = await boot(wrap);
    // The receipt store still holds the task's record, without its pending purchase
    const { error } = await rpc(second, pay(lost, 'nonce-2'));
    expect(error?.code).toBe(NO_FURTHER_MESSAGES);
    expect(calls.verify).toBe(1);
  });
});

describe('createStoredPendingPayments', () => {
  const PURCHASE = { contextId: 'ctx-1', resourceId: 'report', input: { symbol: 'ETH' } };
  let store: ReceiptStore &
    Required<Pick<ReceiptStore, 'putPendingTask' | 'getPendingTask' | 'takePendingTask'>>;

  beforeEach(async () => {
    const opened = createSqliteReceiptStore({ path, clock: time.clock, logger: NOOP_LOGGER });
    await opened.init();
    store = opened as typeof store;
  });

  afterEach(async () => {
    await store.close();
  });

  it('refuses a new purchase when full, keeping the live ones', async () => {
    const pending = createStoredPendingPayments(store, time.clock, 2);
    expect(await pending.put('task-1', PURCHASE)).toBe(true);
    expect(await pending.put('task-2', PURCHASE)).toBe(true);
    expect(await pending.put('task-3', PURCHASE)).toBe(false);

    expect(await pending.get('task-1')).toBeDefined();
    expect(await pending.get('task-3')).toBeUndefined();

    time.advance(HOUR);
    expect(await pending.put('task-3', PURCHASE)).toBe(true);
  });

  it('holds a purchase until the requirement expires, and never past an hour', async () => {
    const pending = createStoredPendingPayments(store, time.clock);
    await pending.put('short', PURCHASE, new Date(START + MINUTE).toISOString());
    await pending.put('long', PURCHASE, new Date(START + 24 * HOUR).toISOString());
    await pending.put('unset', PURCHASE);

    time.advance(MINUTE - 1);
    expect(await pending.get('short')).toBeDefined();
    time.advance(1);
    expect(await pending.get('short')).toBeUndefined();
    expect(await pending.get('unset')).toBeDefined();

    time.advance(HOUR - MINUTE - 1);
    expect(await pending.get('long')).toBeDefined();
    time.advance(1);
    expect(await pending.get('long')).toBeUndefined();
    expect(await pending.get('unset')).toBeUndefined();
  });

  it('takes a task once', async () => {
    const pending = createStoredPendingPayments(store, time.clock);
    await pending.put('task-1', { ...PURCHASE, network: 'eip155:31337' });

    expect(await pending.take('task-1')).toMatchObject({ ...PURCHASE, network: 'eip155:31337' });
    expect(await pending.take('task-1')).toBeUndefined();
    expect(await pending.get('task-1')).toBeUndefined();
  });

  it('answers only for tasks this adapter wrote', async () => {
    const pending = createStoredPendingPayments(store, time.clock);
    const expiresAt = new Date(START + MINUTE).toISOString();
    await store.putPendingTask(
      { id: 'foreign', protocol: 'acp', resourceId: 'report', input: {}, expiresAt },
      { maxTasks: 10 },
    );
    await store.putPendingTask(
      { id: 'bare', protocol: 'a2a', resourceId: 'report', input: {}, expiresAt },
      { maxTasks: 10 },
    );

    expect(await pending.get('foreign')).toBeUndefined();
    expect(await pending.get('bare')).toBeUndefined();
    // A take puts another adapter's task back instead of destroying it
    expect(await pending.take('foreign')).toBeUndefined();
    expect(await store.getPendingTask('foreign')).toMatchObject({ protocol: 'acp' });
  });

  it('deletes expired input on a take and on the next start, not only on a new purchase', async () => {
    const pending = createStoredPendingPayments(store, time.clock);
    const rows = () => {
      const db = new Database(path, { readonly: true });
      try {
        return db.prepare('SELECT id FROM pending_tasks').all();
      } finally {
        db.close();
      }
    };
    await pending.put('first', PURCHASE, new Date(START + MINUTE).toISOString());
    await pending.put('second', PURCHASE, new Date(START + 2 * MINUTE).toISOString());

    time.advance(MINUTE);
    await pending.take('unknown');
    expect(rows()).toEqual([{ id: 'second' }]);

    time.advance(MINUTE);
    await store.close();
    const reopened = createSqliteReceiptStore({ path, clock: time.clock, logger: NOOP_LOGGER });
    await reopened.init();
    store = reopened as typeof store;
    expect(rows()).toEqual([]);
  });

  describe('the mandate', () => {
    // Replaces the stored row with one that lives longer, so only the mandate's own expiry is at play
    async function reput(id: string, ms: number): Promise<void> {
      await store.putPendingTask(
        {
          id,
          protocol: 'a2a',
          resourceId: 'report',
          input: {},
          adapterData: { contextId: 'ctx-1' },
          expiresAt: new Date(START + ms).toISOString(),
        },
        { maxTasks: 10 },
      );
    }

    it('comes back with the task while this process holds it', async () => {
      const pending = createStoredPendingPayments(store, time.clock);
      await pending.put('task-1', { ...PURCHASE, authorization: MANDATE });

      expect(await pending.get('task-1')).toMatchObject({ authorization: MANDATE });
      expect(await pending.take('task-1')).toMatchObject({ authorization: MANDATE });
    });

    it('is dropped when the task is taken', async () => {
      const pending = createStoredPendingPayments(store, time.clock);
      await pending.put('task-1', { ...PURCHASE, authorization: MANDATE }, undefined);
      await pending.take('task-1');

      await reput('task-1', HOUR);
      expect(await pending.get('task-1')).not.toHaveProperty('authorization');
    });

    it('is dropped when the task expires', async () => {
      const pending = createStoredPendingPayments(store, time.clock);
      await pending.put(
        'task-1',
        { ...PURCHASE, authorization: MANDATE },
        new Date(START + MINUTE).toISOString(),
      );

      time.advance(MINUTE);
      await reput('task-1', HOUR);
      expect(await pending.get('task-1')).not.toHaveProperty('authorization');
    });

    it('is dropped when the adapter stops, leaving the task in the store', async () => {
      const pending = createStoredPendingPayments(store, time.clock);
      await pending.put('task-1', { ...PURCHASE, authorization: MANDATE });

      pending.clear();

      const after = await pending.get('task-1');
      expect(after).toMatchObject(PURCHASE);
      expect(after).not.toHaveProperty('authorization');
    });

    it('is not kept for a task the store refused', async () => {
      const pending = createStoredPendingPayments(store, time.clock, 0);

      expect(await pending.put('task-1', { ...PURCHASE, authorization: MANDATE })).toBe(false);

      await reput('task-1', HOUR);
      expect(await pending.get('task-1')).not.toHaveProperty('authorization');
    });
  });
});
