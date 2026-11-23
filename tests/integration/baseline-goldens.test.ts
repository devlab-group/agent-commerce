/**
 * 2.7.2 baseline for x402 challenges over HTTP, MCP and A2A, remote facilitator
 * request bodies, the well-known document and a healthy `doctor --json` report.
 *
 * Keep challenge and facilitator request bytes unchanged when 2.8.0 options are
 * disabled. If a change alters a golden, update its file in the same commit and
 * explain why.
 *
 * The 2.8.0 baseline captures A2A responses: the Agent Card, free calls,
 * paid calls without proof, x402 extension tasks and selected refusal cases
 * from the A2A conformance suite. Snapshots replace server-generated UUIDs
 * with `<uuid>` and preserve ID prefixes.
 *
 * The gateway uses the provider and adapter setup from `runGateway`. One loopback
 * server fakes the JSON-RPC nodes, remote facilitator and merchant backend.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAp2AuthorizationProvider } from '../../src/authorization/ap2';
import { printDoctorReport, runDoctor } from '../../src/cli/commands/doctor';
import { type GatewayConfig, parseConfig } from '../../src/config';
import { NOOP_LOGGER, PAYMENT_HEADER, PAYMENT_REQUIRED_HEADER } from '../../src/core';
import { createGateway } from '../../src/gateway';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers';
import { createPaymentProof } from '../../src/payments/x402/client';
import { createA2aAdapter } from '../../src/protocols/a2a';
import { A2A_X402_EXTENSION_URI } from '../../src/protocols/a2a/x402-extension';
import { createAcpAdapter } from '../../src/protocols/acp';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createSqliteReceiptStore } from '../../src/storage/receipts';
import { PACKAGE_VERSION } from '../../src/version';
import { createParties } from '../unit/authorization-ap2/fixtures';
import { createCapturingIo } from '../unit/cli/fixtures';

process.env['NODE_ENV'] = 'test';

const BASE_SEPOLIA = 'eip155:84532';
const ARBITRUM_SEPOLIA = 'eip155:421614';
const PAY_TO = '0x1111111111111111111111111111111111111111';
// Anvil account 2. LOCAL DEVELOPMENT ONLY - DO NOT FUND
const BUYER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const BUYER = privateKeyToAccount(BUYER_KEY).address;
// A fixed nonce and validity window keep the signature and payment payload deterministic
const NONCE = `0x${'42'.repeat(32)}` as const;
const VALID_BEFORE = 4_102_444_800;
const TX = `0x${'ab'.repeat(32)}`;
const GOLDEN = './goldens/2.7.2';

// Capture raw facilitator request bodies by route
const facilitatorBodies: Record<string, string[]> = { verify: [], settle: [] };
let upstream: Server;
let upstreamUrl = '';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Use the chain ID from the RPC path and report code at any address.
// Return 6 for eth_call to satisfy the token decimals health check.
function rpcResult(chainId: number, method: string): unknown {
  if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
  if (method === 'eth_getCode') return '0x6080';
  if (method === 'eth_call') return `0x${'6'.padStart(64, '0')}`;
  return undefined;
}

function startUpstream(): Promise<void> {
  upstream = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? '';
    const reply = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const rpc = /^\/rpc\/(\d+)$/.exec(path);
    if (rpc) {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result = rpcResult(Number(rpc[1]), method);
      reply(
        result === undefined
          ? { jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } }
          : { jsonrpc: '2.0', id, result },
      );
      return;
    }
    if (path === '/facilitator/supported') {
      reply({
        kinds: [BASE_SEPOLIA, ARBITRUM_SEPOLIA].map((network) => ({
          x402Version: 2,
          scheme: 'exact',
          network,
        })),
        extensions: [],
        signers: {},
      });
      return;
    }
    if (path === '/facilitator/verify') {
      facilitatorBodies['verify']?.push(body);
      reply({ isValid: true, payer: BUYER });
      return;
    }
    if (path === '/facilitator/settle') {
      facilitatorBodies['settle']?.push(body);
      reply({ success: true, transaction: TX, network: BASE_SEPOLIA, payer: BUYER });
      return;
    }
    if (path.startsWith('/backend/')) {
      reply({ ok: true });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    upstream.listen(0, '127.0.0.1', () => {
      upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

const pathInput = {
  type: 'object',
  properties: { checkout_session_id: { type: 'string' } },
  required: ['checkout_session_id'],
  additionalProperties: false,
};
const bodyInput = { type: 'object', additionalProperties: true };

// Define a free checkout operation exposed only through ACP
function acpResource(method: string, path: string, withPath: boolean, withBody: boolean) {
  return {
    name: `ACP ${method} ${path}`,
    input: {
      type: 'object',
      properties: {
        ...(withPath ? { path: pathInput } : {}),
        ...(withBody ? { body: bodyInput } : {}),
      },
      required: withPath ? ['path'] : ['body'],
      additionalProperties: false,
    },
    backend: {
      type: 'http',
      method,
      url: `${upstreamUrl}/backend${path}`,
      inputBindings: {
        ...(withPath ? { path: 'path' } : {}),
        ...(withBody ? { body: 'body' } : {}),
      },
    },
    pricing: { type: 'free' },
    expose: ['acp'],
  };
}

// Configure HTTP, MCP, A2A and ACP with x402, MPP and AP2 using the 2.7.2 config format
async function goldenConfig(
  x402: Record<string, unknown>,
  extraResources: Record<string, unknown> = {},
): Promise<GatewayConfig> {
  const parties = await createParties();
  const session = '/checkout_sessions/{checkout_session_id}';
  return parseConfig(
    {
      version: 1,
      merchant: {
        id: 'golden-store',
        name: 'Golden Store',
        publicBaseUrl: 'https://gateway.example',
      },
      server: { port: 8080, host: '127.0.0.1' },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: {
        http: { enabled: true },
        mcp: { enabled: true, mountPath: '/mcp' },
        a2a: { enabled: true, mountPath: '/a2a' },
        acp: {
          enabled: true,
          mountPath: '/acp',
          auth: { type: 'bearer', token: 'golden-acp-token' },
          idempotency: { retentionHours: 24 },
          checkout: {
            operations: {
              createCheckoutSession: 'acp_create',
              updateCheckoutSession: 'acp_update',
              getCheckoutSession: 'acp_get',
              completeCheckoutSession: 'acp_complete',
              cancelCheckoutSession: 'acp_cancel',
            },
          },
        },
      },
      resources: {
        market_report: {
          name: 'Market Report',
          description: 'Latest market analysis for a symbol.',
          input: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
            required: ['symbol'],
            additionalProperties: false,
          },
          backend: { type: 'http', method: 'GET', url: `${upstreamUrl}/backend/report` },
          pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
          expose: ['http', 'mcp', 'a2a'],
          payments: ['x402'],
        },
        // Require AP2 on a resource to keep doctor from warning that AP2 is unused
        ap2_report: {
          name: 'Mandated Report',
          input: { type: 'object', properties: {}, additionalProperties: false },
          backend: { type: 'http', method: 'GET', url: `${upstreamUrl}/backend/ap2-report` },
          pricing: { type: 'fixed', amount: '0.02', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
          authorization: { required: ['ap2'] },
        },
        mpp_report: {
          name: 'MPP Report',
          input: { type: 'object', properties: {}, additionalProperties: false },
          backend: { type: 'http', method: 'GET', url: `${upstreamUrl}/backend/mpp-report` },
          pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
          expose: ['http'],
          payments: ['mpp'],
        },
        acp_create: acpResource('POST', '/checkout_sessions', false, true),
        acp_update: acpResource('POST', session, true, true),
        acp_get: acpResource('GET', session, true, false),
        acp_complete: acpResource('POST', `${session}/complete`, true, true),
        acp_cancel: acpResource('POST', `${session}/cancel`, true, true),
        ...extraResources,
      },
      payments: {
        x402: {
          enabled: true,
          facilitator: { mode: 'remote', url: `${upstreamUrl}/facilitator` },
          maxTimeoutSeconds: 120,
          ...x402,
        },
        mpp: {
          enabled: true,
          network: BASE_SEPOLIA,
          rpcUrl: `${upstreamUrl}/rpc/84532`,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          assetName: 'USDC',
          assetVersion: '2',
          recipient: PAY_TO,
          realm: 'gateway.example',
          challengeSecret: 'golden-mpp-challenge-secret-'.padEnd(32, 'x'),
          facilitator: { mode: 'remote', url: `${upstreamUrl}/facilitator` },
        },
      },
      authorization: {
        ap2: {
          enabled: true,
          specVersion: '0.2.0',
          mode: 'direct',
          trust: {
            mandateIssuers: parties.mandateIssuers,
            checkoutIssuers: parties.checkoutIssuers,
          },
        },
      },
    },
    {},
  );
}

function singleOffer(): Record<string, unknown> {
  return { network: BASE_SEPOLIA, rpcUrl: `${upstreamUrl}/rpc/84532`, payTo: PAY_TO };
}

function multiOffer(): Record<string, unknown> {
  return {
    options: [
      { network: BASE_SEPOLIA, payTo: PAY_TO },
      { network: ARBITRUM_SEPOLIA, payTo: PAY_TO, assetTransferMethod: 'permit2' },
    ],
    networks: {
      [BASE_SEPOLIA]: { rpcUrl: `${upstreamUrl}/rpc/84532` },
      [ARBITRUM_SEPOLIA]: { rpcUrl: `${upstreamUrl}/rpc/421614` },
    },
  };
}

interface Running {
  readonly url: string;
  readonly config: GatewayConfig;
  close(): Promise<void>;
}

// Wire the store, providers and adapters as in `runGateway`, without signal handlers
async function startGateway(config: GatewayConfig): Promise<Running> {
  const store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  const paymentProviders = await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER);
  const ap2 = config.authorization?.ap2;
  const authorizationProviders = ap2?.enabled
    ? [createAp2AuthorizationProvider({ config: ap2, logger: NOOP_LOGGER, store })]
    : [];
  const { mcp, a2a, acp } = config.protocols;
  if (!acp.enabled) throw new Error('the golden config enables ACP');
  const gateway = await createGateway({
    config: { ...config, server: { ...config.server, port: 0 } },
    store,
    paymentProviders,
    authorizationProviders,
    protocolAdapters: [
      createMcpAdapter({ mountPath: mcp.mountPath }),
      createA2aAdapter({ mountPath: a2a.mountPath, agentName: config.merchant.name, store }),
      createAcpAdapter({
        mountPath: acp.mountPath,
        token: acp.auth.token,
        operations: acp.checkout.operations,
        idempotency: acp.idempotency,
        store,
      }),
    ],
    logger: NOOP_LOGGER,
  });
  const { url } = await gateway.listen();
  return {
    url,
    config,
    async close() {
      await gateway.close();
      for (const provider of authorizationProviders) provider.close();
      await store.close();
    },
  };
}

// Require the captured bytes to match compact or two-space-indented JSON.
// Normalize loopback URLs, the package version and ISO timestamps for stable snapshots.
function golden(raw: string, gatewayUrl: string): string {
  const parsed: unknown = JSON.parse(raw);
  const pretty = JSON.stringify(parsed, null, 2);
  expect([JSON.stringify(parsed), pretty]).toContain(raw);
  return `${pretty}\n`
    .replaceAll(upstreamUrl, 'http://upstream.invalid')
    .replaceAll(gatewayUrl, 'http://gateway.invalid')
    .replaceAll(PACKAGE_VERSION, '<package-version>')
    .replaceAll(/"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g, '"<timestamp>"');
}

// Snapshot discovery and require a healthy `doctor --json` report from the gateway
async function expectDiscoveryGoldens(running: Running, suffix: string): Promise<void> {
  const res = await fetch(`${running.url}/.well-known/agent-commerce`);
  expect(res.status).toBe(200);
  await expect(golden(await res.text(), running.url)).toMatchFileSnapshot(
    `${GOLDEN}/well-known-${suffix}.json`,
  );

  const report = await runDoctor(
    { gatewayUrl: running.url },
    {
      loadConfig: async () => running.config,
      fillEnvFromManifest: (env) => ({ env, filled: [], manifestFound: false }),
      hasChainDeployScript: () => false,
    },
  );
  expect(report.exitCode).toBe(0);
  expect(report.score.passed).toBe(report.score.total);
  const io = createCapturingIo();
  printDoctorReport(report, io, true);
  await expect(golden(io.out.join('\n'), running.url)).toMatchFileSnapshot(
    `${GOLDEN}/doctor-${suffix}.json`,
  );
}

async function challengeHeader(url: string): Promise<string> {
  const res = await fetch(`${url}/api/resources/market_report/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'ETH' }),
  });
  expect(res.status).toBe(402);
  const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
  if (header === null) throw new Error('no PAYMENT-REQUIRED header');
  return Buffer.from(header, 'base64').toString('utf8');
}

beforeAll(startUpstream);
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

describe('2.7.2 goldens: single x402 offer, every protocol, MPP and AP2', () => {
  let running: Running;

  beforeAll(async () => {
    running = await startGateway(await goldenConfig(singleOffer()));
  });
  afterAll(() => running?.close());

  it('the challenge in PAYMENT-REQUIRED, and the same document on MCP and A2A', async () => {
    const raw = await challengeHeader(running.url);
    await expect(golden(raw, running.url)).toMatchFileSnapshot(
      `${GOLDEN}/x402-challenge-single.json`,
    );
    const envelope = JSON.parse(raw) as Record<string, unknown>;

    const client = new Client({ name: 'golden-client', version: '0.0.0-test' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)) as Transport,
    );
    const mcp = (await client.callTool({
      name: 'market_report',
      arguments: { symbol: 'ETH' },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    await client.close();
    expect(mcp.isError).toBe(true);
    for (const key of Object.keys(envelope)) {
      expect(mcp.structuredContent?.[key]).toEqual(envelope[key]);
    }

    const a2a = await fetch(`${running.url}/a2a`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        'a2a-extensions': A2A_X402_EXTENSION_URI,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'golden',
        method: 'SendMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'msg-golden',
            parts: [
              {
                data: { resource: 'market_report', input: { symbol: 'ETH' } },
                mediaType: 'application/json',
              },
            ],
          },
        },
      }),
    });
    const { task } = (
      (await a2a.json()) as {
        result: { task: { status: { message: { metadata: Record<string, unknown> } } } };
      }
    ).result;
    expect(task.status.message.metadata['x402.payment.required']).toEqual(envelope);
  });

  it('the verify and settle bodies a remote facilitator receives', async () => {
    const envelope = JSON.parse(await challengeHeader(running.url)) as {
      resource: unknown;
      accepts: Record<string, unknown>[];
    };
    const offer = envelope.accepts[0];
    if (offer === undefined) throw new Error('no offer');
    // Include the buyer's resource echo and extension to check that the gateway
    // strips both before forwarding the payment payload to the facilitator
    const signed = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY,
      accepts: offer,
      extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' } } } },
      overrides: { nonce: NONCE, validBefore: VALID_BEFORE },
    });
    const proof = Buffer.from(
      JSON.stringify({
        resource: envelope.resource,
        ...JSON.parse(Buffer.from(signed, 'base64').toString('utf8')),
      }),
    ).toString('base64');
    facilitatorBodies['verify'] = [];
    facilitatorBodies['settle'] = [];

    const paid = await fetch(`${running.url}/api/resources/market_report/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PAYMENT_HEADER]: proof },
      body: JSON.stringify({ symbol: 'ETH' }),
    });
    expect(paid.status).toBe(200);

    const [verify] = facilitatorBodies['verify'] ?? [];
    const [settle] = facilitatorBodies['settle'] ?? [];
    expect(facilitatorBodies['verify']).toHaveLength(1);
    expect(facilitatorBodies['settle']).toHaveLength(1);
    await expect(golden(verify as string, running.url)).toMatchFileSnapshot(
      `${GOLDEN}/facilitator-verify.json`,
    );
    await expect(golden(settle as string, running.url)).toMatchFileSnapshot(
      `${GOLDEN}/facilitator-settle.json`,
    );
  });

  it('the well-known document and a healthy doctor --json report', () =>
    expectDiscoveryGoldens(running, 'single'));
});

describe('2.7.2 goldens: two x402 offers', () => {
  let running: Running;

  beforeAll(async () => {
    running = await startGateway(await goldenConfig(multiOffer()));
  });
  afterAll(() => running?.close());

  it('the challenge in PAYMENT-REQUIRED', async () => {
    const raw = await challengeHeader(running.url);
    await expect(golden(raw, running.url)).toMatchFileSnapshot(
      `${GOLDEN}/x402-challenge-multi.json`,
    );
  });

  it('the well-known document and a healthy doctor --json report', () =>
    expectDiscoveryGoldens(running, 'multi'));
});

const A2A_GOLDEN = './goldens/2.8.0';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

interface A2aAnswer {
  readonly status: number;
  readonly extensions: string | null;
  readonly body: unknown;
}

// Send an A2A request and return a normalized `answer` alongside the parsed `raw` body
async function a2aCall(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ answer: A2aAnswer; raw: Record<string, unknown> }> {
  const res = await fetch(`${url}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    answer: {
      status: res.status,
      extensions: res.headers.get('a2a-extensions'),
      body: JSON.parse(golden(text, url)),
    },
    raw: JSON.parse(text) as Record<string, unknown>,
  };
}

function a2aGolden(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`.replaceAll(UUID, '<uuid>');
}

function a2aSend(params: unknown, id: string | number = 'golden'): unknown {
  return { jsonrpc: '2.0', id, method: 'SendMessage', params };
}

function a2aMessage(parts: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { message: { role: 'ROLE_USER', messageId: 'msg-golden', parts, ...overrides } };
}

const EXTENSION = { 'a2a-extensions': A2A_X402_EXTENSION_URI };
const FREE_PART = { data: { resource: 'weather_free', input: { city: 'Berlin' } } };
const BUY_REPORT = a2aMessage([
  { data: { resource: 'market_report', input: { symbol: 'ETH' } }, mediaType: 'application/json' },
]);

describe('2.8.0 goldens: A2A answers', () => {
  let running: Running;

  beforeAll(async () => {
    running = await startGateway(
      await goldenConfig(singleOffer(), {
        weather_free: {
          name: 'Free Weather',
          input: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
          },
          backend: { type: 'http', method: 'GET', url: `${upstreamUrl}/backend/weather` },
          pricing: { type: 'free' },
          expose: ['a2a'],
        },
      }),
    );
  });
  afterAll(() => running?.close());

  it('the Agent Card', async () => {
    const res = await fetch(`${running.url}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    await expect(golden(await res.text(), running.url)).toMatchFileSnapshot(
      `${A2A_GOLDEN}/a2a-agent-card.json`,
    );
  });

  it('a free call, and a paid call without a proof or the extension', async () => {
    const free = await a2aCall(running.url, a2aSend(a2aMessage([FREE_PART])));
    await expect(a2aGolden(free.answer)).toMatchFileSnapshot(`${A2A_GOLDEN}/a2a-free.json`);
    const unpaid = await a2aCall(running.url, a2aSend(BUY_REPORT));
    await expect(a2aGolden(unpaid.answer)).toMatchFileSnapshot(
      `${A2A_GOLDEN}/a2a-paid-no-proof.json`,
    );
  });

  it('an x402 extension task, from input-required to completed', async () => {
    const required = await a2aCall(running.url, a2aSend(BUY_REPORT), EXTENSION);
    await expect(a2aGolden(required.answer)).toMatchFileSnapshot(
      `${A2A_GOLDEN}/a2a-x402-input-required.json`,
    );

    const { task } = required.raw['result'] as {
      task: {
        id: string;
        contextId: string;
        status: { message: { metadata: Record<string, { accepts: Record<string, unknown>[] }> } };
      };
    };
    const offer = task.status.message.metadata['x402.payment.required']?.accepts[0];
    if (offer === undefined) throw new Error('no offer');
    const signed = await createPaymentProof({
      buyerPrivateKey: BUYER_KEY,
      accepts: offer,
      overrides: { nonce: NONCE, validBefore: VALID_BEFORE },
    });
    const paid = await a2aCall(
      running.url,
      a2aSend({
        message: {
          role: 'ROLE_USER',
          messageId: 'msg-pay',
          taskId: task.id,
          contextId: task.contextId,
          parts: [{ text: 'Here is the payment authorization.' }],
          metadata: {
            'x402.payment.status': 'payment-submitted',
            'x402.payment.payload': JSON.parse(Buffer.from(signed, 'base64').toString('utf8')),
          },
        },
      }),
      EXTENSION,
    );
    expect(paid.raw['result']).toMatchObject({
      task: { status: { state: 'TASK_STATE_COMPLETED' } },
    });
    await expect(a2aGolden(paid.answer)).toMatchFileSnapshot(
      `${A2A_GOLDEN}/a2a-x402-completed.json`,
    );
  });

  it('each refusal of the A2A conformance suite, and an unknown resource', async () => {
    const rpc = (method: string, params: unknown) => ({ jsonrpc: '2.0', id: 1, method, params });
    const cases: Record<string, unknown> = {
      'malformed JSON': '{"jsonrpc": "2.0", "id"',
      'jsonrpc 1.0': { jsonrpc: '1.0', id: 1, method: 'SendMessage' },
      'no method': { jsonrpc: '2.0', id: 1 },
      'non-object request': '"SendMessage"',
      'params not an object': rpc('SendMessage', 'nope'),
      'no id': { jsonrpc: '2.0', method: 'SendMessage', params: a2aMessage([FREE_PART]) },
      'legacy message/send': rpc('message/send', a2aMessage([FREE_PART])),
      'unknown method': rpc('Frobnicate', {}),
      ListTasks: rpc('ListTasks', {}),
      SendStreamingMessage: rpc('SendStreamingMessage', {}),
      SubscribeToTask: rpc('SubscribeToTask', {}),
      GetExtendedAgentCard: rpc('GetExtendedAgentCard', {}),
      GetTask: rpc('GetTask', { id: 'task-1' }),
      CancelTask: rpc('CancelTask', { id: 'task-1' }),
      CreateTaskPushNotificationConfig: rpc('CreateTaskPushNotificationConfig', {}),
      GetTaskPushNotificationConfig: rpc('GetTaskPushNotificationConfig', {}),
      ListTaskPushNotificationConfigs: rpc('ListTaskPushNotificationConfigs', {}),
      DeleteTaskPushNotificationConfig: rpc('DeleteTaskPushNotificationConfig', {}),
      ROLE_AGENT: a2aSend(a2aMessage([FREE_PART], { role: 'ROLE_AGENT' })),
      'text part': a2aSend(a2aMessage([{ text: 'what is the weather' }])),
      'raw part': a2aSend(a2aMessage([{ raw: 'QUFBQQ==', filename: 'a.bin' }])),
      'url part': a2aSend(a2aMessage([{ url: 'https://example.com/a.pdf' }])),
      'v0.3 file part': a2aSend(a2aMessage([{ file: { uri: 'https://example.com/a.pdf' } }])),
      'two parts': a2aSend(a2aMessage([FREE_PART, FREE_PART])),
      'non-JSON data part': a2aSend(a2aMessage([{ ...FREE_PART, mediaType: 'text/csv' }])),
      'no messageId': a2aSend(a2aMessage([FREE_PART], { messageId: undefined })),
      'unknown taskId': a2aSend(a2aMessage([FREE_PART], { taskId: 'task-1' })),
      'contextId without a task': a2aSend(a2aMessage([FREE_PART], { contextId: 'ctx-1' })),
      referenceTaskIds: a2aSend(a2aMessage([FREE_PART], { referenceTaskIds: ['task-1'] })),
      'unknown resource': a2aSend(
        a2aMessage([{ data: { resource: 'no_such_resource', input: {} } }]),
      ),
    };
    const answers: Record<string, A2aAnswer> = {};
    for (const [name, body] of Object.entries(cases)) {
      answers[name] = (await a2aCall(running.url, body)).answer;
    }
    for (const version of ['0.3', '']) {
      const { answer } = await a2aCall(running.url, a2aSend(a2aMessage([FREE_PART])), {
        'a2a-version': version,
      });
      answers[`A2A-Version "${version}"`] = answer;
    }
    await expect(a2aGolden(answers)).toMatchFileSnapshot(`${A2A_GOLDEN}/a2a-refusals.json`);
  });
});
