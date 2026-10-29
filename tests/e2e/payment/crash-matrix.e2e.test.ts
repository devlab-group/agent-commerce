/**
 * Crash recovery for x402 purchases on local Anvil, including AP2 holds.
 *
 * In-process cases block intercepted store, AP2 and backend calls at selected
 * boundaries, then reopen the databases behind a new gateway. Cleanup calls
 * remain available. The tests inspect operator state and run
 * `agent-commerce reconcile` with finalized chain time at the recorded expiry.
 * A repeat run must leave table rows unchanged and make no facilitator calls.
 * Held facilitator and RPC responses stop settlement before or after a
 * transfer lands.
 *
 * A separate case uses SIGKILL after a transfer lands, with AP2 disabled.
 * Other cases inject write failures without simulating a crash.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestClient, http } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAp2AuthorizationProvider } from '../../../src/authorization/ap2';
import { AP2_CHECKOUT_PROFILE } from '../../../src/authorization/ap2/constants';
import { computeInputHash } from '../../../src/authorization/ap2/profile';
import { createAp2ReplayStore } from '../../../src/authorization/ap2/replay-store';
import { runReconcileCommand } from '../../../src/cli/commands/reconcile';
import { type GatewayConfig, parseConfig } from '../../../src/config';
import {
  AUTHORIZATION_HEADER,
  type BackendExecutor,
  type Clock,
  CommerceError,
  NOOP_LOGGER,
  PAYMENT_HEADER,
  type PaymentAttempt,
  type Transaction,
  type TransactionState,
} from '../../../src/core';
import { createGateway } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createPaymentProof } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { dumpTables } from '../../fixtures/sqlite-dump';
import { type HoldingProxy, startHoldingProxy } from '../../fixtures/x402/holding-proxy';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { readBalances } from '../../fixtures/x402/settlement';
import {
  checkoutPayload,
  createParties,
  fixedClock,
  mintMandate,
  type Party,
  signCheckoutJwt,
} from '../../unit/authorization-ap2/fixtures';
import { createCapturingIo } from '../../unit/cli/fixtures';

const PORT = 18798;
const NETWORK = 'eip155:31337';
const TOKEN = 'crash-e2e-operator-token';
const INPUT = { city: 'Berlin' };
const AMOUNT = '1.00';
const CURRENCY = 'USD';
const ONE_USDC = 1_000_000n;
// Mine past Anvil's finality lag
const FINALITY_BLOCKS = 65;
// Advance the operator clock beyond the backend timeout and deadline margin
const PAST_DEADLINE_MS = 60 * 60_000;

type Flow = 'upfront' | 'authorization';
// Match the method call selected as the interruption point
type Point = (method: string, args: readonly unknown[]) => boolean;

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let parties: Party;
const cleanups: (() => Promise<void>)[] = [];

const BACKEND: BackendExecutor = {
  async call() {
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

const step =
  (kind: string): Point =>
  (method, [body]) =>
    method === 'recordTransactionStep' && (body as { kind?: string }).kind === kind;
const receiptSave: Point = (method) => method === 'saveReceipt';
const settledUpdate: Point = (method, [update]) =>
  method === 'updatePaymentAttempt' && (update as { status?: string }).status === 'settled';

function rawConfig(
  dir: string,
  facilitatorUrl: string,
  options: { ap2: boolean } = { ap2: true },
): Record<string, unknown> {
  const issuers = (entries: Party['mandateIssuers']) =>
    entries.map((entry) => ({
      issuer: entry.issuer,
      audience: entry.audience,
      keys: entry.keys.map((key) => ({ kid: key.kid, jwk: key.jwk })),
    }));
  const resource = (flow: Flow) => ({
    name: `Report, ${flow} flow`,
    input: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    backend: {
      type: 'http',
      method: 'GET',
      url: 'http://merchant.invalid/api/report',
      timeoutMs: 60_000,
    },
    pricing: { type: 'fixed', amount: AMOUNT, currency: CURRENCY },
    expose: ['http'],
    payments: ['x402'],
    paymentFlow: flow,
    ...(options.ap2 ? { authorization: { required: ['ap2'] } } : {}),
  });
  return {
    version: 1,
    merchant: { id: 'crash-e2e', name: 'Crash E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [], adminToken: TOKEN },
    storage: { receipts: { driver: 'sqlite', path: join(dir, 'receipts.sqlite') } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      report_upfront: resource('upfront'),
      report_authorization: resource('authorization'),
    },
    payments: {
      x402: {
        enabled: true,
        network: NETWORK,
        rpcUrl: anvil.rpcUrl,
        asset: deployment.asset,
        assetName: deployment.assetName,
        assetVersion: deployment.assetVersion,
        assetDecimals: deployment.assetDecimals,
        payTo: deployment.merchant.address,
        maxTimeoutSeconds: 60,
        facilitator: { mode: 'remote', url: facilitatorUrl, auth: { type: 'none' } },
      },
    },
    ...(options.ap2
      ? {
          authorization: {
            ap2: {
              enabled: true,
              specVersion: '0.2.0',
              mode: 'direct',
              trust: {
                mandateIssuers: issuers(parties.mandateIssuers),
                checkoutIssuers: issuers(parties.checkoutIssuers),
              },
              clockSkewSeconds: 60,
              replay: { path: join(dir, 'ap2.sqlite') },
            },
          },
        }
      : {}),
  };
}

interface Env {
  readonly dir: string;
  readonly config: GatewayConfig;
  readonly receipts: string;
  readonly replay: string;
  // In front of the facilitator, and between the facilitator and the chain
  readonly front: HoldingProxy;
  readonly rpc: HoldingProxy;
  readonly facilitator: LoopbackFacilitator;
}

async function stack(options: { ap2: boolean } = { ap2: true }): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'oac-crash-e2e-'));
  const rpc = await startHoldingProxy(anvil.rpcUrl);
  const facilitator = await startLoopbackFacilitator({
    evm: {
      chains: [{ network: NETWORK, rpcUrl: rpc.url }],
      signerPrivateKey: deployment.facilitator.privateKey,
    },
  });
  const front = await startHoldingProxy(facilitator.url);
  cleanups.push(async () => {
    await front.close();
    await rpc.close();
    await facilitator.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const raw = rawConfig(dir, front.url, options);
  return {
    dir,
    config: parseConfig(raw, {}),
    receipts: join(dir, 'receipts.sqlite'),
    replay: join(dir, 'ap2.sqlite'),
    front,
    rpc,
    facilitator,
  };
}

function ap2Of(config: GatewayConfig) {
  const ap2 = config.authorization?.ap2;
  if (ap2 === undefined || !ap2.enabled) throw new Error('the case config must enable AP2');
  return ap2;
}

// Run `before` for method calls except `close`; a returned promise replaces
// the target method call
function intercept<T extends object>(
  target: T,
  before: (method: string, args: readonly unknown[]) => Promise<never> | undefined,
): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== 'function') return value;
      if (key === 'close') return value.bind(object);
      return (...args: unknown[]) => before(String(key), args) ?? value.apply(object, args);
    },
  });
}

interface Crash {
  readonly hit: Promise<'crashed'>;
  tripped: boolean;
  trip(): void;
}

function crashSwitch(): Crash {
  let resolve!: (value: 'crashed') => void;
  const crash: Crash = {
    hit: new Promise((r) => {
      resolve = r;
    }),
    tripped: false,
    trip() {
      crash.tripped = true;
      resolve('crashed');
    },
  };
  return crash;
}

// Once the crash switch trips, intercepted calls return pending promises.
// A matching `point` trips it before the target method runs.
function frozen<T extends object>(target: T, crash: Crash, point?: Point): T {
  return intercept(target, (method, args) => {
    if (!crash.tripped && point?.(method, args) === true) crash.trip();
    return crash.tripped ? new Promise<never>(() => {}) : undefined;
  });
}

// Reject the first matching call; let subsequent calls run normally
function failingOnce<T extends object>(target: T, point: Point): T {
  let failed = false;
  return intercept(target, (method, args) => {
    if (failed || !point(method, args)) return undefined;
    failed = true;
    return Promise.reject(new CommerceError('STORAGE_ERROR', `injected ${method} failure`));
  });
}

interface Invocation {
  readonly statusCode: number;
  json(): unknown;
}

interface Gateway {
  invoke(flow: Flow, headers?: Record<string, string>): Promise<Invocation>;
  close(): Promise<void>;
}

type Wrap = <T extends object>(target: T) => T;

async function startGateway(
  env: Env,
  wrap: { readonly store?: Wrap; readonly ap2?: Wrap; readonly backend?: Wrap } = {},
): Promise<Gateway> {
  const store = createSqliteReceiptStore({ path: env.receipts, logger: NOOP_LOGGER });
  await store.init();
  const ap2 = createAp2AuthorizationProvider({ config: ap2Of(env.config), clock: fixedClock() });
  const identity: Wrap = (target) => target;
  const gateway = await createGateway({
    config: env.config,
    store: (wrap.store ?? identity)(store),
    paymentProviders: await createConfiguredPaymentProviders(env.config.payments, NOOP_LOGGER),
    authorizationProviders: [(wrap.ap2 ?? identity)(ap2)],
    protocolAdapters: [],
    backend: (wrap.backend ?? identity)(BACKEND),
    logger: NOOP_LOGGER,
  });
  return {
    invoke: (flow, headers = {}) =>
      gateway.server.inject({
        method: 'POST',
        url: `/api/resources/report_${flow}/invoke`,
        headers: { 'content-type': 'application/json', ...headers },
        payload: INPUT,
      }),
    async close() {
      await gateway.close();
      ap2.close();
      await store.close();
    },
  };
}

// Build a mandate for the purchase terms with a fresh checkout `jti`
async function mandateFor(flow: Flow): Promise<string> {
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({
      jti: `checkout_${crypto.randomUUID()}`,
      agent_commerce: {
        profile: AP2_CHECKOUT_PROFILE,
        resource_id: `report_${flow}`,
        input_hash: computeInputHash(INPUT),
        amount: AMOUNT,
        currency: CURRENCY,
        payment_method: 'x402',
        destination: deployment.merchant.address,
        network: NETWORK,
        asset: deployment.asset,
      },
    }),
  );
  const presentation = await mintMandate(parties.mandateSigner, jwt);
  return Buffer.from(JSON.stringify({ method: 'ap2', payload: presentation }), 'utf8').toString(
    'base64url',
  );
}

// Build an x402 proof from a fresh challenge and add AP2 headers when requested
async function paymentHeaders(
  invoke: (headers?: Record<string, string>) => Promise<Invocation>,
  flow: Flow | undefined,
): Promise<Record<string, string>> {
  const challenge = await invoke();
  expect(challenge.statusCode).toBe(402);
  const payment = (challenge.json() as { payment: { accepts: Record<string, unknown>[] } }).payment;
  const proof = await createPaymentProof({
    buyerPrivateKey: deployment.buyer.privateKey,
    accepts: payment.accepts[0] as Record<string, unknown>,
  });
  return {
    [PAYMENT_HEADER]: proof,
    ...(flow !== undefined ? { [AUTHORIZATION_HEADER]: await mandateFor(flow) } : {}),
  };
}

function balances() {
  return readBalances({
    rpcUrl: anvil.rpcUrl,
    asset: deployment.asset,
    buyer: deployment.buyer.address,
    merchant: deployment.merchant.address,
  });
}

function shiftedClock(offsetMs: number): Clock {
  return {
    now: () => new Date(Date.now() + offsetMs),
    nowIso: () => new Date(Date.now() + offsetMs).toISOString(),
    monotonicMs: () => performance.now(),
  };
}

interface View {
  readonly transaction: Transaction;
  readonly attempt: PaymentAttempt;
  // Whether `GET /api/transactions?unresolved=true` lists it
  readonly unresolved: boolean;
}

// Read the case's transaction from a gateway reopened on the same files,
// with its clock advanced by `offsetMs`
async function operatorView(env: Env, offsetMs = 0): Promise<View> {
  const clock = shiftedClock(offsetMs);
  const store = createSqliteReceiptStore({ path: env.receipts, clock, logger: NOOP_LOGGER });
  await store.init();
  const gateway = await createGateway({
    config: env.config,
    store,
    paymentProviders: await createConfiguredPaymentProviders(env.config.payments, NOOP_LOGGER),
    protocolAdapters: [],
    backend: BACKEND,
    logger: NOOP_LOGGER,
    clock,
  });
  try {
    const get = async <T>(url: string): Promise<T> => {
      const response = await gateway.server.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json<T>();
    };
    const all = await get<{ transactions: Transaction[] }>('/api/transactions');
    expect(all.transactions).toHaveLength(1);
    const id = (all.transactions[0] as Transaction).id;
    const unresolved = await get<{ transactions: Transaction[] }>(
      '/api/transactions?unresolved=true',
    );
    const detail = await get<{ transaction: Transaction; attempt: PaymentAttempt }>(
      `/api/transactions/${id}`,
    );
    return { ...detail, unresolved: unresolved.transactions.some((t) => t.id === id) };
  } finally {
    await gateway.close();
    await store.close();
  }
}

function replayState(env: Env, reference: string) {
  const replay = createAp2ReplayStore({ path: env.replay });
  try {
    return replay.stateOf(reference);
  } finally {
    replay.close();
  }
}

function testClient() {
  return createTestClient({ mode: 'anvil', transport: http(anvil.rpcUrl) });
}

interface ReconcileJson {
  readonly entries: readonly {
    readonly attemptId: string;
    readonly outcome: string;
    readonly reason: string;
    readonly written: boolean;
    readonly externalReference?: string;
  }[];
  readonly holds: readonly { readonly hold: string; readonly written: boolean }[];
}

async function reconcile(env: Env): Promise<ReconcileJson> {
  const io = createCapturingIo();
  const code = await runReconcileCommand({ json: true, actor: 'crash-e2e', minAge: '0' }, io, {
    loadConfig: async () => env.config,
  });
  expect(io.err).toEqual([]);
  expect(code).toBe(0);
  return JSON.parse(io.out.join('\n')) as ReconcileJson;
}

// Run reconcile twice with `timestamp` finalized, then restore the chain.
// Check that the repeat leaves table rows unchanged and that neither run
// calls the facilitator.
async function reconcileAt(env: Env, timestamp: bigint): Promise<ReconcileJson> {
  const snapshot = await testClient().snapshot();
  try {
    await testClient().setNextBlockTimestamp({ timestamp });
    await testClient().mine({ blocks: FINALITY_BLOCKS });
    const facilitatorCalls = env.facilitator.requests.length;
    const first = await reconcile(env);
    const databases = [env.receipts, env.replay].filter((path) => existsSync(path));
    const written = databases.map(dumpTables);
    const second = await reconcile(env);
    expect(second.entries.filter((entry) => entry.written)).toEqual([]);
    expect(second.holds.filter((hold) => hold.written)).toEqual([]);
    expect(databases.map(dumpTables)).toEqual(written);
    expect(env.facilitator.requests).toHaveLength(facilitatorCalls);
    return first;
  } finally {
    await testClient().revert({ id: snapshot });
  }
}

const expirySeconds = (transaction: Transaction) =>
  BigInt(Date.parse(transaction.payment.expiresAt ?? '') / 1000);

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  parties = await createParties();
}, 120_000);

afterEach(async () => {
  // Run cleanup in reverse order so child gateways stop before their files are removed
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  await anvil?.stop();
});

interface CrashCase {
  readonly point: string;
  readonly flow: Flow;
  // Stop at a store or backend call, or hold settlement before the
  // facilitator receives it or after the transfer lands
  readonly at:
    | { readonly store: Point }
    | { readonly backend: true }
    | { readonly hold: 'landed' | 'not-landed' };
  // Settlement recorded and AP2 hold consumed before the stop
  readonly paid: boolean;
  // Operator states at restart and after the backend deadline
  readonly restart: readonly [TransactionState, TransactionState];
  readonly journal: { readonly settling: boolean; readonly backend?: 'no-status' | 200 };
  // Expected reconciliation outcome; omitted when the attempt is not a candidate
  readonly verdict?: 'settled' | 'not-settled';
  // Operator state after reconciliation and the backend deadline
  readonly final: TransactionState;
}

const CASES: readonly CrashCase[] = [
  {
    point: '1. before settlement',
    flow: 'upfront',
    at: { store: step('settling') },
    paid: false,
    restart: ['payment-pending', 'payment-pending'],
    journal: { settling: false },
    verdict: 'not-settled',
    final: 'payment-failed',
  },
  {
    point: '1. before settlement, ahead of the backend',
    flow: 'authorization',
    at: { store: step('backend-dispatched') },
    paid: false,
    restart: ['payment-pending', 'payment-pending'],
    journal: { settling: false },
    verdict: 'not-settled',
    final: 'payment-failed',
  },
  {
    point: '2. after settlement dispatch, transfer landed',
    flow: 'upfront',
    at: { hold: 'landed' },
    paid: false,
    restart: ['payment-pending', 'payment-pending'],
    journal: { settling: true },
    verdict: 'settled',
    final: 'settled-undelivered',
  },
  {
    point: '2. after settlement dispatch, transfer landed, backend already 2xx',
    flow: 'authorization',
    at: { hold: 'landed' },
    paid: false,
    restart: ['payment-pending', 'payment-pending'],
    journal: { settling: true, backend: 200 },
    verdict: 'settled',
    final: 'delivery-unknown',
  },
  {
    point: '2. after settlement dispatch, nothing landed',
    flow: 'upfront',
    at: { hold: 'not-landed' },
    paid: false,
    restart: ['payment-pending', 'payment-pending'],
    journal: { settling: true },
    verdict: 'not-settled',
    final: 'payment-failed',
  },
  {
    point: '2. after settlement dispatch, nothing landed',
    flow: 'authorization',
    at: { hold: 'not-landed' },
    paid: false,
    restart: ['payment-pending', 'payment-pending'],
    journal: { settling: true, backend: 200 },
    verdict: 'not-settled',
    final: 'payment-failed',
  },
  {
    point: '3. after backend dispatch',
    flow: 'upfront',
    at: { backend: true },
    paid: true,
    restart: ['delivery-started', 'delivery-unknown'],
    journal: { settling: true, backend: 'no-status' },
    final: 'delivery-unknown',
  },
  {
    point: '3. after backend dispatch',
    flow: 'authorization',
    at: { backend: true },
    paid: false,
    restart: ['delivery-started', 'payment-pending'],
    journal: { settling: false, backend: 'no-status' },
    verdict: 'not-settled',
    final: 'payment-failed',
  },
  {
    point: '4. after backend success',
    flow: 'upfront',
    at: { store: step('backend-result') },
    paid: true,
    restart: ['delivery-started', 'delivery-unknown'],
    journal: { settling: true, backend: 'no-status' },
    final: 'delivery-unknown',
  },
  {
    point: '4. after backend success, before settlement',
    flow: 'authorization',
    at: { store: step('settling') },
    paid: false,
    restart: ['payment-pending', 'payment-pending'],
    journal: { settling: false, backend: 200 },
    verdict: 'not-settled',
    final: 'payment-failed',
  },
  {
    point: '5. before receipt commit',
    flow: 'upfront',
    at: { store: receiptSave },
    paid: true,
    restart: ['delivery-started', 'delivery-unknown'],
    journal: { settling: true, backend: 200 },
    final: 'delivery-unknown',
  },
  {
    point: '5. before receipt commit',
    flow: 'authorization',
    at: { store: receiptSave },
    paid: true,
    restart: ['delivery-started', 'delivery-unknown'],
    journal: { settling: true, backend: 200 },
    final: 'delivery-unknown',
  },
];

// Check the recorded journal facts exposed by the operator view
function expectJournal(transaction: Transaction, journal: CrashCase['journal']): void {
  expect(transaction.payment.settlingAt !== undefined).toBe(journal.settling);
  expect(
    transaction.backend === undefined ? undefined : (transaction.backend.status ?? 'no-status'),
  ).toBe(journal.backend);
  expect(transaction.completedAt).toBeUndefined();
  expect(transaction.receiptId).toBeUndefined();
}

describe('crash matrix: restart, operator view and reconcile', () => {
  it.each(CASES)('$point ($flow flow)', async (c) => {
    const env = await stack();
    const crash = crashSwitch();
    const point = 'store' in c.at ? c.at.store : undefined;
    const gateway = await startGateway(env, {
      store: (target) => frozen(target, crash, point),
      ap2: (target) => frozen(target, crash),
      backend: (target) =>
        frozen(target, crash, 'backend' in c.at ? (method) => method === 'call' : undefined),
    });
    const before = await balances();
    const headers = await paymentHeaders((extra) => gateway.invoke(c.flow, extra), c.flow);
    if ('hold' in c.at) {
      const held =
        c.at.hold === 'landed'
          ? env.rpc.hold((_, body) => body.includes('"eth_sendRawTransaction"'), { forward: true })
          : env.front.hold((path) => path === '/settle', { forward: false });
      void held.then(() => crash.trip());
    }

    const finished = gateway.invoke(c.flow, headers).then((response) => response.statusCode);
    expect(await Promise.race([crash.hit, finished])).toBe('crashed');
    await gateway.close();

    const moved = c.paid || ('hold' in c.at && c.at.hold === 'landed') ? ONE_USDC : 0n;
    expect(await balances()).toEqual({
      buyer: before.buyer - moved,
      merchant: before.merchant + moved,
    });

    const now = await operatorView(env);
    expect(now.transaction.state).toBe(c.restart[0]);
    expect(now.unresolved).toBe(true);
    expect(now.attempt.status).toBe(c.paid ? 'settled' : 'reserved');
    expectJournal(now.transaction, c.journal);
    const reference = now.transaction.authorization?.reservationId ?? '';
    const hold = c.paid ? 'consumed' : 'reserved';
    expect(now.transaction.authorization?.hold).toBe(hold);
    expect(replayState(env, reference)).toBe(hold);
    expect((await operatorView(env, PAST_DEADLINE_MS)).transaction.state).toBe(c.restart[1]);

    const report = await reconcileAt(env, expirySeconds(now.transaction));

    const after = await operatorView(env, PAST_DEADLINE_MS);
    expect(after.transaction.state).toBe(c.final);
    expect(after.unresolved).toBe(c.final !== 'payment-failed');
    expectJournal(after.transaction, c.journal);
    if (c.verdict === undefined) {
      expect(report).toMatchObject({ entries: [], holds: [] });
      expect(after.transaction.authorization?.hold).toBe(hold);
      expect(replayState(env, reference)).toBe(hold);
      return;
    }
    const settled = c.verdict === 'settled';
    expect(report.entries).toEqual([
      expect.objectContaining({
        attemptId: now.attempt.id,
        outcome: c.verdict,
        reason: settled ? 'transfer_final' : 'expired_unused',
        written: true,
      }),
    ]);
    const target = settled ? 'consumed' : 'released';
    expect(report.holds).toEqual([expect.objectContaining({ hold: target, written: true })]);
    expect(after.attempt).toMatchObject({
      status: settled ? 'settled' : 'rejected',
      resolution: { method: 'reconcile', actor: 'crash-e2e' },
    });
    expect(after.transaction.authorization?.hold).toBe(target);
    expect(replayState(env, reference)).toBe(target);
  });
});

describe('store failures at the same points, without a crash', () => {
  it.each([
    ['the settling step', step('settling'), ['journal'], 'delivered'],
    ['the backend-dispatched step', step('backend-dispatched'), ['journal'], 'delivered'],
    ['the backend-result step', step('backend-result'), ['journal'], 'delivery-unknown'],
    ['the receipt', receiptSave, ['receipt'], 'delivered'],
  ] as const)(
    'a failed write of %s delivers and is recorded',
    async (_, point, failures, state) => {
      const env = await stack();
      const gateway = await startGateway(env, { store: (target) => failingOnce(target, point) });
      const before = await balances();
      const headers = await paymentHeaders((extra) => gateway.invoke('upfront', extra), 'upfront');

      const paid = await gateway.invoke('upfront', headers);
      await gateway.close();

      expect(paid.statusCode).toBe(200);
      expect((await balances()).buyer).toBe(before.buyer - ONE_USDC);
      const view = await operatorView(env);
      expect(view.transaction).toMatchObject({ state, persistenceFailures: failures });
      expect(view.unresolved).toBe(state !== 'delivered');
      expect(view.attempt.status).toBe('settled');
      expect(view.transaction.completedAt).toBeDefined();
    },
  );

  it('a failed settled-attempt update leaves payment-pending until reconcile finds the transfer', async () => {
    const env = await stack();
    const gateway = await startGateway(env, {
      store: (target) => failingOnce(target, settledUpdate),
    });
    const before = await balances();
    const headers = await paymentHeaders((extra) => gateway.invoke('upfront', extra), 'upfront');

    const paid = await gateway.invoke('upfront', headers);
    await gateway.close();

    expect(paid.statusCode).toBe(200);
    expect((await balances()).buyer).toBe(before.buyer - ONE_USDC);
    const view = await operatorView(env);
    expect(view.transaction).toMatchObject({
      state: 'payment-pending',
      persistenceFailures: ['payment-attempt'],
      authorization: { hold: 'consumed' },
    });
    expect(view.attempt.status).toBe('reserved');

    const report = await reconcileAt(env, expirySeconds(view.transaction));

    expect(report.entries).toEqual([
      expect.objectContaining({ outcome: 'settled', reason: 'transfer_final', written: true }),
    ]);
    expect(report.holds).toEqual([]);
    expect(await operatorView(env)).toMatchObject({
      transaction: { state: 'delivered' },
      unresolved: false,
    });
  });
});

describe('an AP2 hold write failure without a crash', () => {
  it('a failed consume after settlement delivers, and reconcile consumes the hold', async () => {
    const env = await stack();
    const gateway = await startGateway(env, {
      ap2: (target) => failingOnce(target, (method) => method === 'consume'),
    });
    const headers = await paymentHeaders((extra) => gateway.invoke('upfront', extra), 'upfront');

    const paid = await gateway.invoke('upfront', headers);
    await gateway.close();

    expect(paid.statusCode).toBe(200);
    const view = await operatorView(env);
    expect(view.transaction).toMatchObject({
      state: 'delivered',
      authorization: { hold: 'reserved' },
    });
    const reference = view.transaction.authorization?.reservationId ?? '';
    expect(replayState(env, reference)).toBe('reserved');

    const report = await reconcileAt(env, expirySeconds(view.transaction));

    expect(report).toMatchObject({
      entries: [],
      holds: [expect.objectContaining({ hold: 'consumed', written: true })],
    });
    expect(replayState(env, reference)).toBe('consumed');
    expect((await operatorView(env)).transaction.authorization?.hold).toBe('consumed');
  });
});

describe('a child-process gateway killed mid-settlement', () => {
  it('matches the in-process crash after the transfer lands', async () => {
    const env = await stack({ ap2: false });
    const path = join(env.dir, 'config.yaml');
    writeFileSync(path, JSON.stringify(rawConfig(env.dir, env.front.url, { ap2: false })));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', 'start', '--config', path],
      {
        env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_, signal) => resolve(signal)),
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        const listening = stdout
          .split('\n')
          .filter((line) => line.startsWith('{') && line.endsWith('}'))
          .map((line) => JSON.parse(line) as { msg?: string; url?: string })
          .find((line) => line.msg === 'gateway listening');
        if (listening?.url !== undefined) resolve(listening.url);
      });
      void exited.then(() => reject(new Error(`gateway exited: ${stderr}`)));
    });
    const invoke = async (headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}/api/resources/report_upfront/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(INPUT),
      });
      const body: unknown = await response.json();
      return { statusCode: response.status, json: () => body };
    };
    const before = await balances();
    const headers = await paymentHeaders(invoke, undefined);
    const landed = env.rpc.hold((_, body) => body.includes('"eth_sendRawTransaction"'), {
      forward: true,
    });

    const paid = invoke(headers).catch(() => 'connection lost');
    await landed;
    child.kill('SIGKILL');

    expect(await exited).toBe('SIGKILL');
    expect(await paid).toBe('connection lost');
    expect(await balances()).toEqual({
      buyer: before.buyer - ONE_USDC,
      merchant: before.merchant + ONE_USDC,
    });
    const now = await operatorView(env);
    expect(now.transaction.state).toBe('payment-pending');
    expect(now.attempt.status).toBe('reserved');
    expectJournal(now.transaction, { settling: true });

    const report = await reconcileAt(env, expirySeconds(now.transaction));

    expect(report.entries).toEqual([
      expect.objectContaining({ outcome: 'settled', reason: 'transfer_final', written: true }),
    ]);
    expect((await operatorView(env, PAST_DEADLINE_MS)).transaction.state).toBe(
      'settled-undelivered',
    );
  });
});
