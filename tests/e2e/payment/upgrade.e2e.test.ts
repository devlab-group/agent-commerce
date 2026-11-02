/**
 * Tests migration of simulated 2.5.0 data to a single receipt database on local Anvil.
 *
 * Current AP2 and ACP implementations write history to their legacy replay
 * and idempotency files. Store factories seed records representing interrupted
 * requests. Dropping the tables added in schema v5
 * recreates schema v4, which is checked against the 2.5.0 fixture.
 * Upgraded gateways run `agent-commerce start` in child processes on these
 * files.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createTestClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAp2AuthorizationProvider } from '../../../src/authorization/ap2';
import { AP2_CHECKOUT_PROFILE } from '../../../src/authorization/ap2/constants';
import { computeInputHash } from '../../../src/authorization/ap2/profile';
import { createAp2ReplayStore } from '../../../src/authorization/ap2/replay-store';
import { createAp2MandateVerifier } from '../../../src/authorization/ap2/verifier';
import { runBackupCommand } from '../../../src/cli/commands/backup';
import { runReconcileCommand } from '../../../src/cli/commands/reconcile';
import { type GatewayConfig, parseConfig } from '../../../src/config';
import { AUTHORIZATION_HEADER, NOOP_LOGGER, PAYMENT_HEADER, systemClock } from '../../../src/core';
import { createGateway } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createPaymentProof } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { A2A_X402_EXTENSION_URI } from '../../../src/protocols/a2a/x402-extension';
import { createAcpAdapter } from '../../../src/protocols/acp';
import { requestFingerprint } from '../../../src/protocols/acp/idempotency/fingerprint';
import { createAcpIdempotencyStore } from '../../../src/protocols/acp/idempotency/store';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { dumpTables } from '../../fixtures/sqlite-dump';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import {
  type BalanceSnapshot,
  readBalances,
  waitForBalances,
} from '../../fixtures/x402/settlement';
import {
  checkoutPayload,
  createParties,
  mintMandate,
  type Party,
  signCheckoutJwt,
} from '../../unit/authorization-ap2/fixtures';
import { createCapturingIo } from '../../unit/cli/fixtures';

const PORT = 18797;
const NETWORK = 'eip155:31337';
const PUBLIC_BASE_URL = 'http://127.0.0.1:8080';
const ACP_TOKEN = 'upgrade-e2e-acp-token';
const INPUT = { city: 'Berlin' };
const AMOUNT = '1.00';
const CURRENCY = 'USD';
const ONE_USDC = 1_000_000n;
const HOUR_MS = 3_600_000;
// Mine past Anvil's finality lag, as in the reconciliation E2E tests
const FINALITY_BLOCKS = 65;
const IMPORTED =
  'imported deprecated store file; it stays locked against writes while this gateway runs';
const V5_TABLES = ['authorization_holds', 'idempotency_keys', 'legacy_imports', 'pending_tasks'];
const FIXTURE_V4 = readFileSync(
  new URL('../../unit/storage-receipts/fixtures/receipts-v4.sql', import.meta.url),
  'utf8',
);
const ACP_EXAMPLES = JSON.parse(
  readFileSync('tests/fixtures/acp/2026-04-17/examples.agentic_checkout.json', 'utf8'),
) as Record<string, Record<string, unknown>>;
const ACP_OPERATIONS = {
  createCheckoutSession: 'acp_create',
  updateCheckoutSession: 'acp_update',
  getCheckoutSession: 'acp_get',
  completeCheckoutSession: 'acp_complete',
  cancelCheckoutSession: 'acp_cancel',
} as const;
const ACP_BODY = { line_items: [{ id: 'item_123' }], currency: 'usd', capabilities: {} };

type Flow = 'upfront' | 'authorization';
const FLOWS: readonly Flow[] = ['upfront', 'authorization'];

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let parties: Party;
let rpc: SwitchableRpc;
let facilitator: LoopbackFacilitator;
let merchant: Merchant;
let root: string;
const children: ChildGateway[] = [];

// Forward to Anvil; with `lose` set, replace the broadcast response with an
// error after the transfer lands, hiding its outcome from the facilitator
interface SwitchableRpc {
  readonly url: string;
  lose: boolean;
  close(): Promise<void>;
}

async function startSwitchableRpc(upstream: string): Promise<SwitchableRpc> {
  const state = { lose: false };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const forwarded = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await forwarded.text();
    const call = JSON.parse(body) as { id?: unknown; method?: string };
    response.setHeader('content-type', 'application/json');
    response.end(
      state.lose && call.method === 'eth_sendRawTransaction'
        ? JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'reset' } })
        : text,
    );
  });
  await listen(server);
  return {
    url: urlOf(server),
    get lose() {
      return state.lose;
    },
    set lose(value: boolean) {
      state.lose = value;
    },
    close: () => close(server),
  };
}

// A shared merchant API that counts requests by path
interface Merchant {
  readonly url: string;
  readonly calls: Map<string, number>;
  reportStatus: number;
  checkoutStatus: number;
  close(): Promise<void>;
}

async function startMerchant(): Promise<Merchant> {
  const calls = new Map<string, number>();
  const state = { reportStatus: 200, checkoutStatus: 201 };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://merchant').pathname;
    calls.set(path, (calls.get(path) ?? 0) + 1);
    request.resume();
    const [status, body] =
      path === '/report'
        ? [state.reportStatus, { report: 'ok' }]
        : path === '/acp_create'
          ? [state.checkoutStatus, ACP_EXAMPLES['create_checkout_session_response']]
          : [200, ACP_EXAMPLES['get_checkout_session_response']];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await listen(server);
  return {
    url: urlOf(server),
    calls,
    get reportStatus() {
      return state.reportStatus;
    },
    set reportStatus(value: number) {
      state.reportStatus = value;
    },
    get checkoutStatus() {
      return state.checkoutStatus;
    },
    set checkoutStatus(value: number) {
      state.checkoutStatus = value;
    },
    close: () => close(server),
  };
}

const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

// Keep both legacy paths set, as 2.5 required for enabled AP2 and ACP
function rawConfig(dir: string, options: { merchantIdempotent?: boolean } = {}) {
  const issuers = (entries: Party['mandateIssuers']) =>
    entries.map((entry) => ({
      issuer: entry.issuer,
      audience: entry.audience,
      keys: entry.keys.map((key) => ({ kid: key.kid, jwk: key.jwk })),
    }));
  const input = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  };
  const paid = (flow: Flow, expose: 'http' | 'a2a') => ({
    name: `${expose} report, ${flow} flow`,
    input,
    backend: { type: 'http', method: 'GET', url: `${merchant.url}/report` },
    pricing: { type: 'fixed', amount: AMOUNT, currency: CURRENCY },
    expose: [expose],
    payments: ['x402'],
    paymentFlow: flow,
    ...(expose === 'http' ? { authorization: { required: ['ap2'] } } : {}),
  });
  const checkout = Object.fromEntries(
    Object.values(ACP_OPERATIONS).map((id) => [
      id,
      {
        name: id,
        // Keep the nested body schema open: config defaults objects to closed,
        // which would reject every ACP document when no body fields are declared
        input: {
          type: 'object',
          properties: {
            path: { type: 'object', additionalProperties: true },
            body: { type: 'object', additionalProperties: true },
          },
          additionalProperties: false,
        },
        backend: {
          type: 'http',
          method: 'POST',
          url: `${merchant.url}/${id}`,
          inputBindings: { body: 'body' },
        },
        pricing: { type: 'free' },
        expose: ['acp'],
      },
    ]),
  );
  return {
    version: 1,
    merchant: { id: 'upgrade-e2e', name: 'Upgrade E2E', publicBaseUrl: PUBLIC_BASE_URL },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: join(dir, 'receipts.sqlite') } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: false, mountPath: '/mcp' },
      a2a: { enabled: true, mountPath: '/a2a' },
      acp: {
        enabled: true,
        mountPath: '/acp',
        auth: { type: 'bearer', token: ACP_TOKEN },
        idempotency: {
          path: join(dir, 'acp-idempotency.sqlite'),
          retentionHours: 24,
          merchantIdempotent: options.merchantIdempotent === true,
        },
        checkout: { operations: ACP_OPERATIONS },
      },
    },
    resources: {
      report_upfront: paid('upfront', 'http'),
      report_authorization: paid('authorization', 'http'),
      a2a_upfront: paid('upfront', 'a2a'),
      a2a_authorization: paid('authorization', 'a2a'),
      ...checkout,
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
        maxTimeoutSeconds: 3600,
        facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
      },
    },
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
        replay: { path: join(dir, 'ap2-replay.sqlite') },
      },
    },
  };
}

const configOf = (dir: string, options?: { merchantIdempotent?: boolean }): GatewayConfig =>
  parseConfig(rawConfig(dir, options), {});

function ap2Of(config: GatewayConfig) {
  const ap2 = config.authorization?.ap2;
  if (ap2 === undefined || !ap2.enabled) throw new Error('the config must enable AP2');
  return ap2;
}

// A mandate for one report purchase, valid on the system clock the child uses
async function mandate(flow: Flow, jti: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({
      jti,
      iat: now - 30,
      exp: now + HOUR_MS / 1000,
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
  return mintMandate(parties.mandateSigner, jwt, {
    payloadOverrides: { iat: now - 10, exp: now + HOUR_MS / 1000 },
  });
}

const carrier = (presentation: string) =>
  Buffer.from(JSON.stringify({ method: 'ap2', payload: presentation }), 'utf8').toString(
    'base64url',
  );

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type Send = (
  path: string,
  init: { headers?: Record<string, string>; body?: unknown },
) => Promise<Reply>;

const invokeReport = (send: Send, flow: Flow, headers: Record<string, string> = {}) =>
  send(`/api/resources/report_${flow}/invoke`, { headers, body: INPUT });

// A fresh proof for the challenge the gateway issues now
async function proofFor(send: Send, flow: Flow): Promise<string> {
  const challenge = await invokeReport(send, flow);
  expect(challenge.status).toBe(402);
  const { accepts } = challenge.body['payment'] as { accepts: Record<string, unknown>[] };
  return createPaymentProof({
    buyerPrivateKey: deployment.buyer.privateKey,
    accepts: accepts[0] as Record<string, unknown>,
  });
}

async function buy(send: Send, flow: Flow, presentation: string): Promise<Reply> {
  const proof = await proofFor(send, flow);
  return invokeReport(send, flow, {
    [PAYMENT_HEADER]: proof,
    [AUTHORIZATION_HEADER]: carrier(presentation),
  });
}

const checkoutCreate = (send: Send, key: string) =>
  send('/acp/checkout_sessions', {
    headers: {
      authorization: `Bearer ${ACP_TOKEN}`,
      'api-version': '2026-04-17',
      'idempotency-key': key,
    },
    body: ACP_BODY,
  });

const a2a = (send: Send, message: Record<string, unknown>) =>
  send('/a2a', {
    headers: { 'a2a-version': '1.0', 'a2a-extensions': A2A_X402_EXTENSION_URI },
    body: { jsonrpc: '2.0', id: 'rpc-1', method: 'SendMessage', params: { message } },
  });

interface A2aTask {
  readonly id: string;
  readonly contextId: string;
  readonly status: {
    readonly state: string;
    readonly message?: { readonly metadata?: Record<string, unknown> };
  };
}

const taskOf = (reply: Reply) =>
  (reply.body['result'] as { task?: A2aTask } | undefined)?.task as A2aTask;

function payTask(send: Send, task: A2aTask): Promise<Reply> {
  const required = task.status.message?.metadata?.['x402.payment.required'] as {
    accepts: Record<string, unknown>[];
  };
  return createPaymentProof({
    buyerPrivateKey: deployment.buyer.privateKey,
    accepts: required.accepts[0] as Record<string, unknown>,
  }).then((proof) =>
    a2a(send, {
      role: 'ROLE_USER',
      messageId: `pay-${crypto.randomUUID()}`,
      taskId: task.id,
      contextId: task.contextId,
      parts: [{ text: 'Here is the payment authorization.' }],
      metadata: {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': JSON.parse(Buffer.from(proof, 'base64').toString('utf8')),
      },
    }),
  );
}

const balanceQuery = () => ({
  rpcUrl: anvil.rpcUrl,
  asset: deployment.asset,
  buyer: deployment.buyer.address,
  merchant: deployment.merchant.address,
});
const balances = () => readBalances(balanceQuery());
// The balances once `n` more USDC have moved from the buyer to the merchant
const paidMore = (from: BalanceSnapshot, n: bigint) =>
  waitForBalances(
    balanceQuery(),
    (now) =>
      from.buyer - now.buyer === n * ONE_USDC && now.merchant - from.merchant === n * ONE_USDC,
    30_000,
  );

function readDb<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const schemaOf = (path: string) =>
  readDb(path, (db) => ({
    version: db.pragma('user_version', { simple: true }),
    sql: db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  }));

const markers = (receipts: string) =>
  readDb(receipts, (db) =>
    db.prepare('SELECT source, path, rows, imported_at FROM legacy_imports ORDER BY source').all(),
  );

const holdState = (receipts: string, checkoutJti: string) =>
  readDb(
    receipts,
    (db) =>
      (
        db
          .prepare('SELECT state FROM authorization_holds WHERE binding_reference = ?')
          .get(checkoutJti) as { state: string } | undefined
      )?.state,
  );

const attemptCount = (receipts: string) =>
  readDb(
    receipts,
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM payment_attempts').get() as { n: number }).n,
  );

interface ChildGateway {
  readonly send: Send;
  readonly messages: () => string[];
  stop(): Promise<void>;
}

// `agent-commerce start` on a config file, as an operator runs it
async function startChild(dir: string): Promise<ChildGateway> {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli/index.ts', 'start', '--config', join(dir, 'config.yaml')],
    {
      env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const lines = () =>
    stdout
      .split('\n')
      .filter((line) => line.startsWith('{') && line.endsWith('}'))
      .map((line) => JSON.parse(line) as { msg?: string; url?: string });
  const listening = new Promise<string>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const line = lines().find((entry) => entry.msg === 'gateway listening');
      if (line?.url !== undefined) resolve(line.url);
    });
  });
  const url = await Promise.race([
    listening,
    exited.then((code) => {
      throw new Error(`gateway exited with ${code}: ${stderr}`);
    }),
  ]);
  const gateway: ChildGateway = {
    send: async (path, init) => {
      const response = await fetch(`${url}${path}`, {
        method: init.body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    messages: () => lines().flatMap((line) => (line.msg !== undefined ? [line.msg] : [])),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    },
  };
  children.push(gateway);
  return gateway;
}

interface History {
  readonly mandates: Record<
    'consumedUpfront' | 'consumedAuthorization' | 'released' | 'uncertain' | 'reserved',
    { readonly flow: Flow; readonly jti: string; readonly presentation: string }
  >;
  readonly completedBody: unknown;
}

// Build simulated 2.5 history in `dir` with the legacy file backends, then
// recreate receipt schema v4
async function record25(dir: string): Promise<History> {
  const config = configOf(dir);
  const ap2 = ap2Of(config);
  const acp = config.protocols.acp;
  if (!acp.enabled) throw new Error('the config must enable ACP');
  const receipts = config.storage.receipts.path;
  const mandates: History['mandates'] = {
    consumedUpfront: { flow: 'upfront', jti: 'checkout_consumed_upfront', presentation: '' },
    consumedAuthorization: {
      flow: 'authorization',
      jti: 'checkout_consumed_authorization',
      presentation: '',
    },
    released: { flow: 'authorization', jti: 'checkout_released', presentation: '' },
    uncertain: { flow: 'upfront', jti: 'checkout_uncertain', presentation: '' },
    reserved: { flow: 'upfront', jti: 'checkout_reserved', presentation: '' },
  };
  for (const entry of Object.values(mandates)) {
    (entry as { presentation: string }).presentation = await mandate(entry.flow, entry.jti);
  }

  const store = createSqliteReceiptStore({ path: receipts, logger: NOOP_LOGGER });
  await store.init();
  // Omit the shared store from the AP2 provider and ACP adapter so they use
  // their configured legacy files, as in 2.5
  const authorization = createAp2AuthorizationProvider({ config: ap2, logger: NOOP_LOGGER });
  const gateway = await createGateway({
    config,
    store,
    paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    authorizationProviders: [authorization],
    protocolAdapters: [
      createAcpAdapter({
        mountPath: acp.mountPath,
        token: acp.auth.token,
        operations: acp.checkout.operations,
        idempotency: acp.idempotency,
      }),
    ],
    logger: NOOP_LOGGER,
  });
  const send: Send = async (path, init) => {
    const response = await gateway.server.inject({
      method: init.body === undefined ? 'GET' : 'POST',
      url: path,
      headers: { 'content-type': 'application/json', ...init.headers },
      ...(init.body !== undefined ? { payload: JSON.stringify(init.body) } : {}),
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  };

  const start = await balances();
  expect((await buy(send, 'upfront', mandates.consumedUpfront.presentation)).status).toBe(200);
  expect(
    (await buy(send, 'authorization', mandates.consumedAuthorization.presentation)).status,
  ).toBe(200);
  // The authorization flow settles nothing when the merchant fails
  merchant.reportStatus = 500;
  expect((await buy(send, 'authorization', mandates.released.presentation)).status).toBe(502);
  merchant.reportStatus = 200;
  rpc.lose = true;
  const uncertain = await buy(send, 'upfront', mandates.uncertain.presentation);
  rpc.lose = false;
  expect(uncertain.body).toMatchObject({ details: { settlementUncertain: true } });
  await paidMore(start, 3n);

  const completed = await checkoutCreate(send, 'acp-completed');
  expect(completed.status).toBe(201);
  merchant.checkoutStatus = 500;
  expect((await checkoutCreate(send, 'acp-unresolved')).status).toBeGreaterThanOrEqual(500);
  merchant.checkoutStatus = 201;

  await gateway.close();
  authorization.close();
  await store.close();

  // Simulate a request interrupted after reserving its mandate
  const verified = await createAp2MandateVerifier({ config: ap2, clock: systemClock }).verify(
    mandates.reserved.presentation,
    { requestId: 'req_crashed', resourceId: 'report_upfront' },
  );
  const replay = createAp2ReplayStore({ path: ap2.replay?.path as string });
  expect(
    replay.reserve({
      reference: verified.reference,
      checkoutJti: verified.checkoutJwtId,
      mandateIssuer: verified.mandateIssuer,
      checkoutIssuer: verified.checkoutIssuer,
      resourceId: 'report_upfront',
      requestId: 'req_crashed',
    }),
  ).toEqual({ kind: 'reserved' });
  replay.close();

  // Seed claims dated two days ago: one completed and now expired, one in flight.
  // Keep both writes on one handle and the past clock: reopening recovers
  // in-flight claims, and claiming at the current time purges expired completed
  // rows.
  const acpFile = acp.idempotency.path as string;
  const endpoint = readDb(
    acpFile,
    (db) =>
      (db.prepare('SELECT endpoint FROM acp_idempotency LIMIT 1').get() as { endpoint: string })
        .endpoint,
  );
  const scope = (key: string) => ({ deployment: PUBLIC_BASE_URL, endpoint, key });
  const fingerprint = requestFingerprint(ACP_BODY);
  const past = createAcpIdempotencyStore({
    path: acpFile,
    retentionHours: 24,
    now: () => Date.now() - 48 * HOUR_MS,
  });
  expect(past.claim(scope('acp-expired'), fingerprint)).toEqual({ kind: 'reserved' });
  past.complete(scope('acp-expired'), { status: 201, body: completed.body });
  expect(past.claim(scope('acp-in-flight'), fingerprint)).toEqual({ kind: 'reserved' });
  past.close();

  const db = new Database(receipts);
  for (const table of V5_TABLES) db.exec(`DROP TABLE ${table}`);
  db.pragma('user_version = 4');
  db.close();

  return { mandates, completedBody: completed.body };
}

let live: string;
let idempotent: string;
let config: GatewayConfig;
let history: History;
let gateway: ChildGateway;
let imports: unknown[];

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  parties = await createParties();
  rpc = await startSwitchableRpc(anvil.rpcUrl);
  facilitator = await startLoopbackFacilitator({
    evm: {
      chains: [{ network: NETWORK, rpcUrl: rpc.url }],
      signerPrivateKey: deployment.facilitator.privateKey,
    },
  });
  merchant = await startMerchant();
  root = mkdtempSync(join(tmpdir(), 'oac-upgrade-e2e-'));
  live = join(root, 'live');
  idempotent = join(root, 'idempotent');
  mkdirSync(live);
  mkdirSync(idempotent);
  history = await record25(live);
  // Copy the simulated 2.5 data to test an upgrade with `merchantIdempotent`
  for (const file of ['receipts.sqlite', 'ap2-replay.sqlite', 'acp-idempotency.sqlite']) {
    copyFileSync(join(live, file), join(idempotent, file));
  }
  writeFileSync(join(live, 'config.yaml'), JSON.stringify(rawConfig(live)));
  writeFileSync(
    join(idempotent, 'config.yaml'),
    JSON.stringify(rawConfig(idempotent, { merchantIdempotent: true })),
  );
  config = configOf(live);
}, 180_000);

afterAll(async () => {
  for (const child of children) await child.stop().catch(() => {});
  await merchant?.close();
  await facilitator?.close();
  await rpc?.close();
  await anvil?.stop();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

const receiptsOf = (dir: string) => join(dir, 'receipts.sqlite');

describe('upgrading a 2.5.0 deployment', () => {
  it('starts from a schema v4 database and two deprecated files in every state', () => {
    const fixture = join(root, 'fixture.sqlite');
    const db = new Database(fixture);
    db.exec(FIXTURE_V4);
    db.close();
    expect(schemaOf(receiptsOf(live))).toEqual(schemaOf(fixture));

    const tables = dumpTables(receiptsOf(live));
    const statuses = (tables.payment_attempts as { status: string }[]).map((row) => row.status);
    expect(new Set(statuses)).toEqual(new Set(['settled', 'rejected', 'settlement-uncertain']));
    expect(tables.transactions).toHaveLength(4);
    const ap2States = (
      dumpTables(join(live, 'ap2-replay.sqlite')).ap2_authorizations as {
        checkout_jti: string;
        state: string;
      }[]
    ).map((row) => [row.checkout_jti, row.state]);
    expect(Object.fromEntries(ap2States)).toEqual({
      checkout_consumed_upfront: 'consumed',
      checkout_consumed_authorization: 'consumed',
      checkout_released: 'released',
      checkout_uncertain: 'uncertain',
      checkout_reserved: 'reserved',
    });
    const acpStates = (
      dumpTables(join(live, 'acp-idempotency.sqlite')).acp_idempotency as {
        idempotency_key: string;
        state: string;
      }[]
    ).map((row) => [row.idempotency_key, row.state]);
    expect(Object.fromEntries(acpStates)).toEqual({
      'acp-completed': 'completed',
      'acp-unresolved': 'unresolved',
      'acp-expired': 'completed',
      'acp-in-flight': 'in_flight',
    });
  });

  it('imports both files on the first start, without writing them or opening another file', async () => {
    const legacy = ['ap2-replay.sqlite', 'acp-idempotency.sqlite'].map((file) => join(live, file));
    const before = legacy.map(dumpTables);
    const filesBefore = new Set(readdirSync(live));

    gateway = await startChild(live);

    imports = markers(receiptsOf(live));
    expect(imports).toEqual([
      expect.objectContaining({ source: 'acp-idempotency', path: legacy[1], rows: 4 }),
      expect.objectContaining({ source: 'ap2-replay', path: legacy[0], rows: 5 }),
    ]);
    expect(gateway.messages().filter((msg) => msg === IMPORTED)).toHaveLength(2);
    expect(legacy.map(dumpTables)).toEqual(before);
    // Allow only WAL and SHM sidecars for existing database files
    const added = readdirSync(live).filter((file) => !filesBefore.has(file));
    for (const file of added) {
      expect(file).toMatch(/^(receipts|ap2-replay|acp-idempotency)\.sqlite-(wal|shm)$/);
    }
    expect(schemaOf(receiptsOf(live)).version).toBe(5);
  });

  it.each(FLOWS)(
    'refuses a mandate consumed before the upgrade on the %s flow, before settling',
    async (flow) => {
      const consumed =
        flow === 'upfront'
          ? history.mandates.consumedUpfront
          : history.mandates.consumedAuthorization;
      const funds = await balances();
      const attempts = attemptCount(receiptsOf(live));
      const reports = merchant.calls.get('/report');

      const reply = await buy(gateway.send, flow, consumed.presentation);

      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'AUTHORIZATION_REPLAYED' });
      expect(await balances()).toEqual(funds);
      expect(attemptCount(receiptsOf(live))).toBe(attempts);
      expect(merchant.calls.get('/report')).toBe(reports);
    },
  );

  it('lets the mandate released before the upgrade pay once', async () => {
    const funds = await balances();

    const reply = await buy(gateway.send, 'authorization', history.mandates.released.presentation);

    expect(reply.status).toBe(200);
    await paidMore(funds, 1n);
    expect(holdState(receiptsOf(live), history.mandates.released.jti)).toBe('consumed');
  });

  it('blocks the uncertain and reserved holds until reconcile aligns them', async () => {
    const { uncertain, reserved } = history.mandates;
    for (const held of [uncertain, reserved]) {
      const reply = await buy(gateway.send, held.flow, held.presentation);
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'AUTHORIZATION_REPLAYED' });
    }

    await createTestClient({ mode: 'anvil', transport: http(anvil.rpcUrl) }).mine({
      blocks: FINALITY_BLOCKS,
    });
    const io = createCapturingIo();
    expect(
      await runReconcileCommand({ json: true, actor: 'upgrade-e2e', minAge: '0' }, io, {
        loadConfig: async () => config,
      }),
    ).toBe(0);
    const report = JSON.parse(io.out.join('\n')) as {
      entries: { outcome: string; written: boolean }[];
      holds: { hold: string; written: boolean }[];
      orphanHolds: { requestId: string; released: boolean }[];
    };
    expect(report.entries).toEqual([
      expect.objectContaining({ outcome: 'settled', written: true }),
    ]);
    expect(report.holds).toEqual([expect.objectContaining({ hold: 'consumed', written: true })]);
    expect(report.orphanHolds).toEqual([
      expect.objectContaining({ requestId: 'req_crashed', released: true }),
    ]);
    expect(holdState(receiptsOf(live), uncertain.jti)).toBe('consumed');
    expect(holdState(receiptsOf(live), reserved.jti)).toBe('released');

    // The released orphan's mandate can now pay
    const funds = await balances();
    expect((await buy(gateway.send, reserved.flow, reserved.presentation)).status).toBe(200);
    await paidMore(funds, 1n);
  });

  it('replays a completed checkout, refuses unresolved and crashed claims, and reruns an expired one', async () => {
    const creates = () => merchant.calls.get('/acp_create') ?? 0;
    const before = creates();

    const completed = await checkoutCreate(gateway.send, 'acp-completed');
    expect(completed).toEqual({ status: 201, body: history.completedBody });
    for (const key of ['acp-unresolved', 'acp-in-flight']) {
      const refused = await checkoutCreate(gateway.send, key);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'idempotency_unresolved' });
    }
    expect(creates()).toBe(before);

    expect((await checkoutCreate(gateway.send, 'acp-expired')).status).toBe(201);
    expect(creates()).toBe(before + 1);
  });

  it('frees the crashed claim instead when the merchant is idempotent', async () => {
    const copy = await startChild(idempotent);
    const before = merchant.calls.get('/acp_create') ?? 0;

    expect((await checkoutCreate(copy.send, 'acp-in-flight')).status).toBe(201);
    expect(merchant.calls.get('/acp_create')).toBe(before + 1);
    await copy.stop();
  });

  it('imports nothing on a second start', async () => {
    await gateway.stop();
    gateway = await startChild(live);

    expect(gateway.messages()).not.toContain(IMPORTED);
    expect(markers(receiptsOf(live))).toEqual(imports);
  });

  it('settles an A2A task asked for before a restart once after it, on each flow', async () => {
    const tasks: A2aTask[] = [];
    for (const flow of FLOWS) {
      const asked = await a2a(gateway.send, {
        role: 'ROLE_USER',
        messageId: `buy-${flow}`,
        parts: [{ data: { resource: `a2a_${flow}`, input: INPUT }, mediaType: 'application/json' }],
      });
      expect(taskOf(asked).status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      tasks.push(taskOf(asked));
    }
    await gateway.stop();
    gateway = await startChild(live);

    for (const task of tasks) {
      const funds = await balances();
      const paid = await payTask(gateway.send, task);
      expect(taskOf(paid).status.state).toBe('TASK_STATE_COMPLETED');
      const after = await paidMore(funds, 1n);

      const again = await payTask(gateway.send, task);
      expect(again.body['error']).toBeDefined();
      expect(await balances()).toEqual(after);
    }
  });

  it('restores a backup taken after the upgrade, still refusing spent mandates', async () => {
    const out = join(root, 'backup');
    const io = createCapturingIo();
    expect(await runBackupCommand({ out }, io, { loadConfig: async () => config })).toBe(0);
    // Imported legacy files are omitted from the backup
    expect(readdirSync(out).sort()).toEqual(['backup.json', 'receipts.sqlite']);
    const paidTask = await a2a(gateway.send, {
      role: 'ROLE_USER',
      messageId: 'buy-before-restore',
      parts: [{ data: { resource: 'a2a_upfront', input: INPUT }, mediaType: 'application/json' }],
    });
    await gateway.stop();

    const receipts = receiptsOf(live);
    for (const file of [receipts, `${receipts}-wal`, `${receipts}-shm`]) {
      if (existsSync(file)) unlinkSync(file);
    }
    copyFileSync(join(out, 'receipts.sqlite'), receipts);
    gateway = await startChild(live);

    expect(gateway.messages()).not.toContain(IMPORTED);
    expect(markers(receipts)).toEqual(imports);
    const funds = await balances();
    for (const spent of [history.mandates.consumedUpfront, history.mandates.released]) {
      const reply = await buy(gateway.send, spent.flow, spent.presentation);
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ code: 'AUTHORIZATION_REPLAYED' });
    }
    // A task asked for after the backup is not in it
    expect((await payTask(gateway.send, taskOf(paidTask))).body['error']).toBeDefined();
    expect(await balances()).toEqual(funds);
  });
});
