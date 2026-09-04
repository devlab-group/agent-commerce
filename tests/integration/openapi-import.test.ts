/**
 * OpenAPI import -> config -> gateway -> merchant backend.
 *
 * The point of this suite is that an imported resource is not a parallel
 * feature. It goes through the real CLI command, the real config parser, the
 * real gateway with real MCP and A2A adapters, and the real
 * `HttpBackendExecutor` calling a real (local) merchant server - so the
 * request the merchant receives is the one the gateway actually built, not one
 * a fake executor agreed to. Nothing here injects importer internals into the
 * pipeline.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runImportOpenApi } from '../../src/cli/commands/import-openapi.js';
import { createCapturingIo } from '../../src/cli/lib/io.js';
import { parseConfig } from '../../src/config/index.js';
import {
  type AdapterDescriptor,
  PAYMENT_HEADER,
  type PaymentContext,
  type PaymentProvider,
  type PaymentRequirement,
  type PaymentResult,
  type PaymentVerificationContext,
} from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createA2aAdapter } from '../../src/protocols/a2a/index.js';
import { createMcpAdapter } from '../../src/protocols/mcp/index.js';
import { createFakeStore } from '../unit/gateway/helpers.js';

process.env['NODE_ENV'] = 'test';

const SPEC = fileURLToPath(new URL('./fixtures/merchant-api.openapi.yaml', import.meta.url));

/** Exactly what the merchant backend saw. */
interface InboundRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let merchant: Server;
let merchantUrl: string;
let inbound: InboundRequest[] = [];

beforeAll(async () => {
  merchant = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://merchant.local');
      const raw = Buffer.concat(chunks).toString('utf8');
      inbound.push({
        method: req.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body: raw === '' ? undefined : safeJson(raw),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: url.pathname }));
    });
  });
  await new Promise<void>((resolve) => merchant.listen(0, '127.0.0.1', resolve));
  const address = merchant.address();
  if (address === null || typeof address === 'string') throw new Error('no merchant address');
  merchantUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => merchant.close(() => resolve()));
});

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Runs the real CLI command and returns the parsed `resources:` fragment. */
async function importResources(
  extra: Partial<Parameters<typeof runImportOpenApi>[0]> = {},
): Promise<Record<string, Record<string, unknown>>> {
  const output = join(mkdtempSync(join(tmpdir(), 'oac-import-integration-')), 'resources.yaml');
  const io = createCapturingIo();
  const code = await runImportOpenApi(
    {
      source: SPEC,
      output,
      baseUrl: merchantUrl,
      free: true,
      expose: 'http,mcp,a2a',
      ...extra,
    },
    io,
  );
  expect(code, io.err.join('\n')).toBe(0);
  const parsed = parseYaml(readFileSync(output, 'utf8')) as {
    resources: Record<string, Record<string, unknown>>;
  };
  return parsed.resources;
}

const descriptor: AdapterDescriptor = {
  name: 'fake-x402',
  kind: 'payment',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'n/a',
  capabilities: [],
  status: 'experimental',
};

function createFakeX402Provider(): PaymentProvider & { verified: number; settled: number } {
  const provider = {
    verified: 0,
    settled: 0,
    name: 'x402' as const,
    descriptor,
    createRequirement: async (ctx: PaymentContext): Promise<PaymentRequirement> => ({
      id: 'req-1',
      requestId: ctx.requestId,
      resourceId: ctx.resource.id,
      provider: 'x402',
      amount: ctx.amount,
      currency: ctx.currency,
      destination: '0xMERCHANT',
      challenge: { provider: 'x402', version: '1', accepts: [{ scheme: 'exact' }] },
    }),
    verify: async (ctx: PaymentVerificationContext): Promise<PaymentResult> => {
      provider.verified += 1;
      return {
        status: ctx.submission.payload === 'valid-proof' ? 'verified' : 'rejected',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        replayKey: `replay-${String(ctx.submission.payload)}-${provider.verified}`,
      };
    },
    settle: async (): Promise<PaymentResult> => {
      provider.settled += 1;
      return {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        externalReference: '0xTXHASH',
      };
    },
    health: async () => ({ status: 'pass' as const, checkedAt: '2026-01-01T00:00:00.000Z' }),
  };
  return provider;
}

/** Mirrors the x402 block the other integration suites use; the provider itself is a fake. */
const X402_CONFIG = {
  enabled: true,
  network: 'eip155:84532',
  rpcUrl: 'http://127.0.0.1:8545',
  asset: '0x1111111111111111111111111111111111111111',
  assetName: 'MockUSDC',
  assetVersion: '2',
  assetDecimals: 6,
  payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  maxTimeoutSeconds: 120,
  facilitator: { mode: 'local', signerPrivateKey: '0xTEST_ONLY_NOT_A_REAL_KEY' },
};

function rawConfig(
  resources: Record<string, unknown>,
  withPayments = false,
): Record<string, unknown> {
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1' },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
      a2a: { enabled: true, mountPath: '/a2a' },
    },
    resources,
    payments: withPayments ? { x402: X402_CONFIG } : {},
  };
}

let gateway: GatewayInstance | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  client = undefined;
  gateway = undefined;
  inbound = [];
});

async function startGateway(
  resources: Record<string, unknown>,
  paymentProviders: PaymentProvider[] = [],
): Promise<GatewayInstance> {
  gateway = await createGateway({
    config: parseConfig(rawConfig(resources, paymentProviders.length > 0), {}),
    store: createFakeStore(),
    paymentProviders,
    protocolAdapters: [createMcpAdapter(), createA2aAdapter()],
    // No `backend` override: the real HttpBackendExecutor builds the request.
  });
  return gateway;
}

function invoke(
  gw: GatewayInstance,
  id: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  return gw.server.inject({
    method: 'POST',
    url: `/api/resources/${id}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(input),
  });
}

function sendMessage(resource: string, input: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'SendMessage',
    params: {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-1',
        parts: [{ data: { resource, input }, mediaType: 'application/json' }],
      },
    },
  });
}

const CREATE_ORDER_INPUT = {
  path: { userId: 'u-1' },
  query: { notify: true },
  body: { productId: 'sku-9', quantity: 2 },
};

describe('imported resources over the real gateway', () => {
  let resources: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    resources = await importResources();
  });

  it('imports the supported operations and skips the unsupported one', () => {
    expect(Object.keys(resources).sort()).toEqual([
      'audit',
      'createOrder',
      'getReport',
      'listOrders',
      'search',
    ]);
    // Neither a required multipart body nor a required header parameter
    // produces a runnable resource - approximating either would take payment
    // for a request the merchant cannot serve.
    expect(resources).not.toHaveProperty('upload');
    expect(resources).not.toHaveProperty('tenantReport');
    // The optional array query parameter was dropped, the required one kept.
    const search = resources['search']?.['input'] as {
      properties: { query: { properties: object } };
    };
    expect(Object.keys(search.properties.query.properties)).toEqual(['q']);
  });

  it('sends path, query and body to their own places on one POST', async () => {
    const gw = await startGateway(resources);

    const res = await invoke(gw, 'createOrder', CREATE_ORDER_INPUT);

    expect(res.statusCode).toBe(200);
    expect(inbound).toHaveLength(1);
    const request = inbound[0];
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/users/u-1/orders');
    expect(request?.query).toEqual({ notify: 'true' });
    // The regression this whole binding feature exists to prevent: `notify`
    // must not have ended up inside the JSON body.
    expect(request?.body).toEqual({ productId: 'sku-9', quantity: 2 });
    expect(request?.headers['content-type']).toBe('application/json');
  });

  it('produces the identical merchant request over HTTP, MCP and A2A', async () => {
    const gw = await startGateway(resources);
    const { url } = await gw.listen();

    await invoke(gw, 'createOrder', CREATE_ORDER_INPUT);

    client = new Client({ name: 'import-integration', version: '0.0.0-test' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`)) as unknown as Transport,
    );
    const toolResult = await client.callTool({
      name: 'createOrder',
      arguments: CREATE_ORDER_INPUT,
    });
    expect((toolResult as { isError?: boolean }).isError).not.toBe(true);

    const a2a = await gw.server.inject({
      method: 'POST',
      url: '/a2a',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      payload: sendMessage('createOrder', CREATE_ORDER_INPUT),
    });
    expect(a2a.statusCode).toBe(200);
    expect(a2a.json().error).toBeUndefined();

    expect(inbound).toHaveLength(3);
    const shapes = inbound.map((request) => ({
      method: request.method,
      path: request.path,
      query: request.query,
      body: request.body,
    }));
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it('exposes exactly the generated resources through protocol discovery', async () => {
    const gw = await startGateway(resources);
    const { url } = await gw.listen();

    client = new Client({ name: 'import-integration', version: '0.0.0-test' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`)) as unknown as Transport,
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(resources).sort());

    const card = await gw.server.inject({ method: 'GET', url: '/.well-known/agent-card.json' });
    expect(
      card
        .json<{ skills: { id: string }[] }>()
        .skills.map((skill) => skill.id)
        .sort(),
    ).toEqual(Object.keys(resources).sort());

    // The skipped operation is not reachable by guessing its id either.
    const missing = await invoke(gw, 'upload', {});
    expect(missing.statusCode).toBe(404);
  });

  it('keeps an imported paid resource on the normal payment path', async () => {
    const provider = createFakeX402Provider();
    const paid = {
      ...resources,
      getReport: {
        ...resources['getReport'],
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        payments: ['x402'],
      },
    };
    const gw = await startGateway(paid, [provider]);

    const challenge = await invoke(gw, 'getReport', { path: { reportId: 'r-1' } });
    expect(challenge.statusCode).toBe(402);
    expect(challenge.json().code).toBe('PAYMENT_REQUIRED');
    expect(inbound).toHaveLength(0);

    const delivered = await invoke(
      gw,
      'getReport',
      { path: { reportId: 'r-1' } },
      { [PAYMENT_HEADER]: 'valid-proof' },
    );
    expect(delivered.statusCode).toBe(200);
    expect(provider.settled).toBe(1);
    expect(inbound.map((request) => request.path)).toEqual(['/reports/r-1']);
  });

  it('rejects a bad imported path value before any payment is taken', async () => {
    const provider = createFakeX402Provider();
    const paid = {
      ...resources,
      getReport: {
        ...resources['getReport'],
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        payments: ['x402'],
      },
    };
    const gw = await startGateway(paid, [provider]);

    const res = await invoke(
      gw,
      'getReport',
      { path: { reportId: '..' } },
      { [PAYMENT_HEADER]: 'valid-proof' },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INPUT_INVALID');
    // The money invariant: nothing was verified, nothing settled, nothing sent.
    expect(provider.verified).toBe(0);
    expect(provider.settled).toBe(0);
    expect(inbound).toHaveLength(0);
  });

  it('rejects a query collision with an operator-configured backend query before payment', async () => {
    const provider = createFakeX402Provider();
    const listOrders = resources['listOrders'] as Record<string, unknown>;
    const backend = { ...(listOrders['backend'] as Record<string, unknown>) };
    // The operator pins a query parameter the imported schema also carries.
    backend['url'] = `${String(backend['url'])}?status=archived`;
    const collided = {
      ...resources,
      listOrders: {
        ...listOrders,
        backend,
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        payments: ['x402'],
      },
    };
    const gw = await startGateway(collided, [provider]);

    const res = await invoke(
      gw,
      'listOrders',
      { path: { userId: 'u-1' }, query: { status: 'open' } },
      { [PAYMENT_HEADER]: 'valid-proof' },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INPUT_INVALID');
    expect(provider.settled).toBe(0);
    expect(inbound).toHaveLength(0);
  });

  it('cannot be steered at another host by path input', async () => {
    const gw = await startGateway(resources);

    const res = await invoke(gw, 'listOrders', { path: { userId: 'http://evil.example/x' } });

    expect(res.statusCode).toBe(200);
    expect(inbound).toHaveLength(1);
    // Encoded into one path segment of the configured host, not a new origin.
    expect(inbound[0]?.path).toBe('/users/http%3A%2F%2Fevil.example%2Fx/orders');
  });

  it('carries the security warning without importing any credential', async () => {
    const io = createCapturingIo();
    const output = join(mkdtempSync(join(tmpdir(), 'oac-import-security-')), 'resources.yaml');
    await runImportOpenApi(
      { source: SPEC, output, baseUrl: merchantUrl, free: true, expose: 'http' },
      io,
    );

    const written = readFileSync(output, 'utf8');
    expect(io.out.join('\n')).toContain('audit declares backend authentication');
    expect(written).toContain('No credential was imported');
    expect(written).not.toContain('X-Api-Key');
    expect(written).not.toContain('apiKey');
  });

  it('refuses an external $ref without a single outbound request', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('the importer must not perform network requests');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const io = createCapturingIo();
      const source = fileURLToPath(
        new URL('../unit/openapi/fixtures/external-http-ref.yaml', import.meta.url),
      );
      const code = await runImportOpenApi(
        { source, output: join(mkdtempSync(join(tmpdir(), 'oac-import-ext-')), 'out.yaml') },
        io,
      );
      expect(code).toBe(1);
      expect(io.err.join('\n')).toContain('external reference');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('behaves identically to the same resource written by hand', async () => {
    const handWritten = {
      name: 'Create an order',
      input: resources['createOrder']?.['input'],
      backend: resources['createOrder']?.['backend'],
      pricing: { type: 'free' },
      expose: ['http'],
    };
    const gw = await startGateway({ manual: handWritten, ...resources });

    await invoke(gw, 'manual', CREATE_ORDER_INPUT);
    await invoke(gw, 'createOrder', CREATE_ORDER_INPUT);

    expect(inbound).toHaveLength(2);
    const [manual, imported] = inbound;
    expect({ ...imported, headers: undefined }).toEqual({ ...manual, headers: undefined });
  });
});
