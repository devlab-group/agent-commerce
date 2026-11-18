/**
 * Run `doctor` against a gateway with an unreachable RPC or facilitator, using
 * one x402 offer, two offers and MPP; test an unreachable backend separately.
 * Real viem and x402 SDK clients produce the errors classified by health().
 * A released loopback port simulates a target that does not respond.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor';
import type { DoctorCheck } from '../../src/cli/commands/doctor/types';
import { type GatewayConfig, parseConfig } from '../../src/config';
import { NOOP_LOGGER } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers';
import { createSqliteReceiptStore } from '../../src/storage/receipts';
import { releasedPort } from '../unit/gateway/helpers';

process.env['NODE_ENV'] = 'test';

const BASE_SEPOLIA = 'eip155:84532';
const ARBITRUM_SEPOLIA = 'eip155:421614';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

let upstream: Server;
let upstreamUrl = '';
// A loopback port that was bound and released: a connection to it is refused
let silentUrl = '';

// The RPC returns the chain id from its path, mock bytecode and 6 decimals.
// `/rpc/error` returns JSON-RPC errors. The facilitator supports both networks;
// `/denied/supported` returns 401.
function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      const reply = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const rpc = /^\/rpc\/(\w+)$/.exec(path);
      if (rpc) {
        const { id, method } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: number;
          method: string;
        };
        const chainId = Number(rpc[1]);
        const result =
          method === 'eth_chainId'
            ? `0x${chainId.toString(16)}`
            : method === 'eth_getCode'
              ? '0x6080'
              : method === 'eth_call'
                ? `0x${'6'.padStart(64, '0')}`
                : undefined;
        reply(
          Number.isNaN(chainId) || result === undefined
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
      if (path === '/denied/supported') {
        reply({ error: 'unauthorized' }, 401);
        return;
      }
      if (path.startsWith('/backend/')) {
        reply({ ok: true });
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, '127.0.0.1', () => {
      upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

interface Targets {
  readonly rpc?: string;
  readonly facilitator?: string;
  readonly backend?: string;
}

// One paid resource on the given rail; every target defaults to the healthy upstream
function config(rail: 'x402' | 'x402-multi' | 'mpp', targets: Targets = {}): GatewayConfig {
  const rpc = targets.rpc ?? `${upstreamUrl}/rpc/84532`;
  const facilitator = { mode: 'remote', url: targets.facilitator ?? `${upstreamUrl}/facilitator` };
  const x402 =
    rail === 'x402'
      ? { network: BASE_SEPOLIA, rpcUrl: rpc, payTo: PAY_TO }
      : {
          options: [
            { network: BASE_SEPOLIA, payTo: PAY_TO },
            { network: ARBITRUM_SEPOLIA, payTo: PAY_TO },
          ],
          networks: {
            [BASE_SEPOLIA]: { rpcUrl: rpc },
            [ARBITRUM_SEPOLIA]: { rpcUrl: `${upstreamUrl}/rpc/421614` },
          },
        };
  return parseConfig(
    {
      version: 1,
      merchant: { id: 'certainty', name: 'Certainty', publicBaseUrl: 'https://gateway.example' },
      server: { port: 8080, host: '127.0.0.1' },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        report: {
          name: 'Report',
          input: { type: 'object', properties: {}, additionalProperties: false },
          backend: {
            type: 'http',
            method: 'GET',
            url: `${targets.backend ?? upstreamUrl}/backend/r`,
          },
          pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
          expose: ['http'],
          payments: [rail === 'mpp' ? 'mpp' : 'x402'],
        },
      },
      payments:
        rail === 'mpp'
          ? {
              mpp: {
                enabled: true,
                network: BASE_SEPOLIA,
                rpcUrl: rpc,
                asset: USDC,
                assetName: 'USDC',
                assetVersion: '2',
                recipient: PAY_TO,
                realm: 'gateway.example',
                challengeSecret: 'certainty-mpp-challenge-secret-'.padEnd(32, 'x'),
                facilitator,
              },
            }
          : { x402: { enabled: true, facilitator, maxTimeoutSeconds: 120, ...x402 } },
    },
    {},
  );
}

let gateway: GatewayInstance | undefined;

// Start a gateway with configured payment providers, then run doctor against it
async function doctor(gatewayConfig: GatewayConfig): Promise<Map<string, DoctorCheck>> {
  const store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  gateway = await createGateway({
    config: { ...gatewayConfig, server: { ...gatewayConfig.server, port: 0 } },
    store,
    paymentProviders: await createConfiguredPaymentProviders(gatewayConfig.payments, NOOP_LOGGER),
    protocolAdapters: [],
    logger: NOOP_LOGGER,
  });
  const { url } = await gateway.listen();
  const report = await runDoctor(
    { gatewayUrl: url },
    {
      loadConfig: async () => gatewayConfig,
      fillEnvFromManifest: (env) => ({ env, filled: [], manifestFound: false }),
      hasChainDeployScript: () => false,
    },
  );
  return new Map(report.checks.map((check) => [check.name, check]));
}

beforeAll(async () => {
  await startUpstream();
  silentUrl = await releasedPort();
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe('doctor through a running gateway: a target that gives no answer', () => {
  // In the two-offer config, `rpc` is the first offer's RPC only
  it.each([
    ['x402', 'Payments (offers)', 'rpc'],
    ['x402', 'Payments (offers)', 'facilitator'],
    ['x402-multi', 'Payments (offers)', 'rpc'],
    ['x402-multi', 'Payments (offers)', 'facilitator'],
    ['mpp', 'Payments (MPP offers)', 'rpc'],
    ['mpp', 'Payments (MPP offers)', 'facilitator'],
  ] as const)(
    '%s: %s FAILs, marked unreachable, when the %s is silent',
    async (rail, name, target) => {
      const checks = await doctor(config(rail, { [target]: silentUrl }));
      expect(checks.get(name)).toMatchObject({ status: 'FAIL', undetermined: 'unreachable' });
      // The gateway answered: it is not ready, and that is a verdict
      expect(checks.get('Gateway')).toMatchObject({ status: 'WARN' });
      expect(checks.get('Gateway')).not.toHaveProperty('undetermined');
    },
  );

  it('FAILs Backend, marked unreachable, when the backend host is silent', async () => {
    const checks = await doctor(config('x402', { backend: silentUrl }));
    expect(checks.get('Backend')).toEqual({
      name: 'Backend',
      status: 'FAIL',
      detail: '0/1 backend host(s) reachable',
      undetermined: 'unreachable',
    });
    expect(checks.get('Payments (offers)')).toMatchObject({ status: 'PASS' });
  });

  it('marks nothing when every target answers', async () => {
    for (const rail of ['x402', 'x402-multi', 'mpp'] as const) {
      const checks = await doctor(config(rail));
      expect([...checks.values()].filter((check) => 'undetermined' in check)).toEqual([]);
      await gateway?.close();
      gateway = undefined;
    }
  });
});

describe('doctor through a running gateway: a target that answers wrongly', () => {
  // Thunks: the upstream URL is known only once it listens. `https://` against
  // the plain-HTTP upstream fails the TLS handshake.
  const tls = () => upstreamUrl.replace('http:', 'https:');
  const WRONG: Record<string, () => Targets> = {
    'the RPC returns a JSON-RPC error': () => ({ rpc: `${upstreamUrl}/rpc/error` }),
    'the facilitator answers 401': () => ({ facilitator: `${upstreamUrl}/denied` }),
    'the RPC fails the TLS handshake': () => ({ rpc: `${tls()}/rpc/84532` }),
    'the facilitator fails the TLS handshake': () => ({ facilitator: `${tls()}/facilitator` }),
  };

  it.each(
    (['x402', 'mpp'] as const).flatMap((rail) =>
      Object.keys(WRONG).map(
        (wrong) =>
          [rail, rail === 'mpp' ? 'Payments (MPP offers)' : 'Payments (offers)', wrong] as const,
      ),
    ),
  )('%s: %s FAILs unmarked when %s', async (rail, name, wrong) => {
    const checks = await doctor(config(rail, (WRONG[wrong] as () => Targets)()));
    expect(checks.get(name)?.status).toBe('FAIL');
    expect(checks.get(name)).not.toHaveProperty('undetermined');
  });

  it('FAILs Backend unmarked when its URL uses a port fetch refuses', async () => {
    const checks = await doctor(config('x402', { backend: 'http://127.0.0.1:1' }));
    expect(checks.get('Backend')).toEqual({
      name: 'Backend',
      status: 'FAIL',
      detail: '0/1 backend host(s) reachable',
    });
  });

  it("does not mark two offers when one is silent and the other's RPC answers wrongly", async () => {
    const gatewayConfig = config('x402-multi', { rpc: silentUrl });
    const x402 = gatewayConfig.payments.x402 as NonNullable<GatewayConfig['payments']['x402']>;
    // The second offer's RPC reports Base Sepolia's chain id instead of Arbitrum Sepolia's
    const options = (x402.options ?? []).map((option, index) =>
      index === 1 ? { ...option, rpcUrl: `${upstreamUrl}/rpc/84532` } : option,
    );
    const checks = await doctor({
      ...gatewayConfig,
      payments: { x402: { ...x402, options } },
    });
    expect(checks.get('Payments (offers)')?.status).toBe('FAIL');
    expect(checks.get('Payments (offers)')).not.toHaveProperty('undetermined');
  });
});

describe('doctor without a gateway', () => {
  const run = (gatewayUrl: string) =>
    runDoctor(
      { gatewayUrl },
      {
        loadConfig: async () => config('x402'),
        fillEnvFromManifest: (env) => ({ env, filled: [], manifestFound: false }),
        hasChainDeployScript: () => false,
      },
    );

  it('marks Gateway unreachable when the connection is refused', async () => {
    const gateway = (await run(silentUrl)).checks.find((c) => c.name === 'Gateway');
    expect(gateway).toMatchObject({ status: 'FAIL', undetermined: 'unreachable' });
    expect(gateway?.detail).toMatch(/\(fetch failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/);
  });

  it('leaves Gateway unmarked, and says why, when fetch refuses the port', async () => {
    const report = await run('http://127.0.0.1:1');
    expect(report.checks.find((c) => c.name === 'Gateway')).toEqual({
      name: 'Gateway',
      status: 'FAIL',
      detail: 'unreachable at http://127.0.0.1:1 (fetch failed: bad port)',
    });
    expect(report.checks.find((c) => c.name === 'Protocols')).toMatchObject({
      status: 'FAIL',
      undetermined: 'skipped',
    });
  });
});
