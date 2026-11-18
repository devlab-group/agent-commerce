// Which `doctor` results carry `undetermined`, the printed mark, and the Secrets check
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { printDoctorReport, runDoctor } from '../../../src/cli/commands/doctor';
import type { DoctorDeps } from '../../../src/cli/commands/doctor/types';
import {
  createCapturingIo,
  createFakeFetch,
  fetchFailed,
  jsonResponse,
  makeFakeReceiptStore,
  makeGatewayConfig,
} from './fixtures';

const GATEWAY = 'http://127.0.0.1:8080';
const BACKEND = 'http://localhost:3000/api/weather/demo-check';

const X402 = {
  enabled: true,
  network: 'eip155:31337',
  rpcUrl: 'http://127.0.0.1:8545',
  asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  assetName: 'MockUSDC',
  assetVersion: '2',
  assetDecimals: 6,
  payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  maxTimeoutSeconds: 60,
  facilitator: { mode: 'local' as const, signerPrivateKey: '0xdeadbeef' },
};
const SECOND_ASSET = '0x2222222222222222222222222222222222222222';

const MPP = {
  enabled: true,
  network: 'eip155:84532' as const,
  rpcUrl: 'https://sepolia.example/v2/RPC-KEY',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  assetName: 'USDC',
  assetVersion: '2',
  recipient: '0x1111111111111111111111111111111111111111',
  realm: 'api.example.com',
  challengeSecret: 'CHALLENGE-SECRET-'.padEnd(32, 'x'),
  facilitator: {
    mode: 'remote' as const,
    url: 'https://facilitator.example',
    auth: { type: 'bearer' as const, token: 'FACILITATOR-TOKEN' },
  },
};

const BOTH_RAILS = makeGatewayConfig({ payments: { x402: X402, mpp: MPP } });

type Handlers = Record<string, () => Response | Promise<Response>>;

// A request that fails with an answer: the name does not resolve
const doesNotResolve = (): Response => {
  throw fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND gateway.test');
};

// Healthy responses by default. An undefined handler removes a URL, causing the
// fake fetch to reject that request.
function gatewayFetch(overrides: Record<string, (() => Response) | undefined> = {}) {
  const handlers: Record<string, (() => Response) | undefined> = {
    [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
    [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
    [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse({ merchant: { id: 'm' } }),
    [BACKEND]: () => jsonResponse({}),
    ...overrides,
  };
  return createFakeFetch(
    Object.fromEntries(Object.entries(handlers).filter(([, h]) => h !== undefined)) as Handlers,
  );
}

async function doctor(deps: DoctorDeps) {
  const report = await runDoctor(
    { gatewayUrl: GATEWAY },
    {
      createStore: () => makeFakeReceiptStore(),
      fillEnvFromManifest: (env) => ({ env, filled: [], manifestFound: false }),
      hasChainDeployScript: () => false,
      ...deps,
    },
  );
  return { report, check: (name: string) => report.checks.find((c) => c.name === name) };
}

// Compare a check's status and optional undetermined marker
const verdict = (check: { status: string; undetermined?: string } | undefined) =>
  check === undefined
    ? undefined
    : { status: check.status, ...(check.undetermined ? { mark: check.undetermined } : {}) };

describe('doctor: the gateway and what depends on its document', () => {
  const DEPENDENT = [
    'Gateway',
    'Protocols',
    'Payments',
    'Payments (MPP)',
    'Protocol versions',
  ] as const;

  // `unreachable` when nothing answered, `skipped` when the document was never
  // fetched, nothing when it answered without usable content
  it.each([
    [
      '/health gives no answer',
      { [`${GATEWAY}/health`]: undefined },
      ['FAIL', 'unreachable'],
      'unreachable',
    ],
    ['/health does not resolve', { [`${GATEWAY}/health`]: doesNotResolve }, ['FAIL'], 'skipped'],
    [
      '/health answers 500',
      { [`${GATEWAY}/health`]: () => jsonResponse({}, 500) },
      ['FAIL'],
      'skipped',
    ],
    [
      '/ready rejects the Host',
      { [`${GATEWAY}/ready`]: () => jsonResponse({}, 403) },
      ['FAIL'],
      'skipped',
    ],
    [
      'the document gives no answer',
      { [`${GATEWAY}/.well-known/agent-commerce`]: undefined },
      ['PASS'],
      'unreachable',
    ],
    [
      'the document does not resolve',
      { [`${GATEWAY}/.well-known/agent-commerce`]: doesNotResolve },
      ['PASS'],
      undefined,
    ],
    [
      'the document answers 500',
      { [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse({}, 500) },
      ['PASS'],
      undefined,
    ],
  ] as const)('when %s', async (_label, overrides, [gatewayStatus, gatewayMark], cause) => {
    const { check } = await doctor({
      fetchImpl: gatewayFetch(overrides),
      loadConfig: async () => BOTH_RAILS,
    });
    const mark = cause !== undefined ? { mark: cause } : {};
    expect(Object.fromEntries(DEPENDENT.map((name) => [name, verdict(check(name))]))).toEqual({
      Gateway: { status: gatewayStatus, ...(gatewayMark ? { mark: gatewayMark } : {}) },
      Protocols: { status: 'FAIL', ...mark },
      Payments: { status: 'INFO', ...mark },
      'Payments (MPP)': { status: 'INFO', ...mark },
      'Protocol versions': { status: 'INFO', ...mark },
    });
  });

  it('says a gateway that answered non-2xx is unhealthy, not unreachable', async () => {
    const { check } = await doctor({
      fetchImpl: gatewayFetch({ [`${GATEWAY}/health`]: () => jsonResponse({}, 500) }),
      loadConfig: async () => BOTH_RAILS,
    });
    expect(check('Gateway')?.detail).toBe(`unhealthy at ${GATEWAY} (HTTP 500)`);
    expect(check('Protocol versions')?.detail).toMatch(/^gateway versions unavailable; local pins/);
  });

  it('leaves Payments unmarked when the document answers without a payments block', async () => {
    const { check } = await doctor({
      fetchImpl: gatewayFetch(),
      loadConfig: async () => BOTH_RAILS,
    });
    expect(verdict(check('Payments'))).toEqual({ status: 'INFO' });
    expect(verdict(check('Payments (MPP)'))).toEqual({ status: 'INFO' });
  });

  it.each([
    ['gives no answer', undefined, { status: 'WARN', mark: 'unreachable' }],
    ['does not resolve', doesNotResolve, { status: 'WARN' }],
    ['answers 503', () => jsonResponse({}, 503), { status: 'WARN' }],
  ] as const)('WARNs a gateway whose /ready %s', async (_label, ready, expected) => {
    const { check } = await doctor({
      fetchImpl: gatewayFetch({ [`${GATEWAY}/ready`]: ready }),
      loadConfig: async () => makeGatewayConfig(),
    });
    expect(verdict(check('Gateway'))).toEqual(expected);
  });
});

describe('doctor: backends', () => {
  // The config has a second resource on another host
  const twoHosts = () => {
    const config = makeGatewayConfig();
    const [first] = config.resources;
    if (first === undefined) throw new Error('the fixture config has a resource');
    const second = {
      ...first,
      id: 'other',
      handler: { ...first.handler, url: 'http://other.test/api' },
    };
    return { ...config, resources: [first, second] };
  };

  it.each([
    [
      'one of two hosts gives no answer',
      { 'http://other.test/api': undefined },
      { status: 'WARN', mark: 'unreachable' },
    ],
    [
      'both give no answer',
      { [BACKEND]: undefined, 'http://other.test/api': undefined },
      { status: 'FAIL', mark: 'unreachable' },
    ],
    [
      'one of two hosts does not resolve',
      { 'http://other.test/api': doesNotResolve },
      { status: 'WARN' },
    ],
    [
      'one host gives no answer and the other does not resolve',
      { [BACKEND]: undefined, 'http://other.test/api': doesNotResolve },
      { status: 'FAIL' },
    ],
    [
      'a host answers 500',
      { 'http://other.test/api': () => jsonResponse({}, 500) },
      { status: 'PASS' },
    ],
  ] as const)('reports Backend, and its mark, when %s', async (_label, overrides, expected) => {
    const { check } = await doctor({
      // Object.assign: every override names the other host, which a spread would flag
      fetchImpl: gatewayFetch(
        Object.assign({ 'http://other.test/api': () => jsonResponse({}) }, overrides),
      ),
      loadConfig: async () => twoHosts(),
    });
    expect(verdict(check('Backend'))).toEqual(expected);
  });
});

describe('doctor: invalid config', () => {
  it('marks every check it skipped, and keeps each status', async () => {
    const { report } = await doctor({
      fetchImpl: gatewayFetch(),
      loadConfig: async () => {
        throw new Error('bad config');
      },
    });
    const marked = report.checks
      .filter((c) => c.undetermined !== undefined)
      .map((c) => [c.name, c.status, c.detail, c.undetermined]);
    expect(marked).toEqual([
      ['Backend', 'WARN', 'skipped: config invalid', 'skipped'],
      ['Protocols', 'WARN', 'skipped: config invalid', 'skipped'],
      ['A2A', 'WARN', 'skipped: config invalid', 'skipped'],
      ['ACP', 'WARN', 'skipped: config invalid', 'skipped'],
      ['AP2', 'WARN', 'skipped: config invalid', 'skipped'],
      ['Payments', 'INFO', 'skipped: config invalid', 'skipped'],
      ['Payments (MPP)', 'INFO', 'skipped: config invalid', 'skipped'],
      ['Storage', 'WARN', 'skipped: config invalid', 'skipped'],
    ]);
    // The failure itself is a verdict
    expect(report.checks.find((c) => c.name === 'Config')).not.toHaveProperty('undetermined');
  });
});

describe('doctor: offer health from the document', () => {
  const offer = (asset: string, status: string, unreachable: boolean) => ({
    network: X402.network,
    asset,
    payTo: X402.payTo,
    status,
    ...(unreachable ? { undetermined: 'unreachable' } : {}),
  });
  const x402Document = (offers: readonly ReturnType<typeof offer>[]) => ({
    merchant: { id: 'm' },
    payments: {
      x402: {
        enabled: true,
        ...(offers[0] as object),
        options: offers,
        paymentFlow: 'authorization',
      },
    },
  });
  const twoOffers = makeGatewayConfig({
    payments: { x402: { ...X402, options: [X402, { ...X402, asset: SECOND_ASSET }] } },
  });

  it.each([
    [
      'every failing offer got no answer',
      [offer(X402.asset, 'fail', true), offer(SECOND_ASSET, 'pass', false)],
      { status: 'FAIL', mark: 'unreachable' },
    ],
    [
      'one failing offer answered',
      [offer(X402.asset, 'fail', true), offer(SECOND_ASSET, 'fail', false)],
      { status: 'FAIL' },
    ],
    [
      'a degraded offer answered',
      [offer(X402.asset, 'fail', true), offer(SECOND_ASSET, 'warn', false)],
      { status: 'FAIL' },
    ],
    [
      'only a degraded offer got no answer',
      [offer(X402.asset, 'pass', false), offer(SECOND_ASSET, 'warn', true)],
      { status: 'WARN', mark: 'unreachable' },
    ],
  ] as const)('Payments (offers) when %s', async (_label, offers, expected) => {
    const { check } = await doctor({
      fetchImpl: gatewayFetch({
        [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse(x402Document(offers)),
      }),
      loadConfig: async () => twoOffers,
    });
    expect(verdict(check('Payments (offers)'))).toEqual(expected);
  });

  it.each([
    ['fail', true, { status: 'FAIL', mark: 'unreachable' }],
    ['fail', false, { status: 'FAIL' }],
    ['pass', false, { status: 'PASS' }],
  ] as const)(
    'Payments (MPP offers) for a %s block (no answer: %s)',
    async (status, unreachable, expected) => {
      const mppDocument = {
        merchant: { id: 'm' },
        payments: {
          mpp: {
            enabled: true,
            network: MPP.network,
            asset: MPP.asset,
            recipient: MPP.recipient,
            paymentFlow: 'upfront',
            status,
            ...(unreachable ? { undetermined: 'unreachable' } : {}),
          },
        },
      };
      const { check } = await doctor({
        fetchImpl: gatewayFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse(mppDocument),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { mpp: MPP } }),
      });
      expect(verdict(check('Payments (MPP)'))).toEqual({ status: 'PASS' });
      expect(verdict(check('Payments (MPP offers)'))).toEqual(expected);
    },
  );
});

describe('doctor: a healthy run', () => {
  it('marks no result', async () => {
    const { report } = await doctor({
      fetchImpl: gatewayFetch(),
      loadConfig: async () => makeGatewayConfig(),
    });
    expect(report.exitCode).toBe(0);
    expect(report.checks.filter((c) => 'undetermined' in c)).toEqual([]);
  });
});

describe('printDoctorReport: the mark', () => {
  it('appends the mark to a text row, and keeps the field in JSON', () => {
    const report = {
      checks: [
        {
          name: 'Gateway',
          status: 'FAIL' as const,
          detail: 'down',
          undetermined: 'unreachable' as const,
        },
        { name: 'Storage', status: 'PASS' as const, detail: 'ok' },
      ],
      score: { passed: 1, total: 2 },
      exitCode: 1,
    };
    const text = createCapturingIo();
    printDoctorReport(report, text, false);
    expect(text.out.slice(0, 2).map((line) => stripVTControlCharacters(line))).toEqual([
      `FAIL  ${'Gateway'.padEnd(20)} down [not determined: unreachable]`,
      `PASS  ${'Storage'.padEnd(20)} ok`,
    ]);
    const json = createCapturingIo();
    printDoctorReport(report, json, true);
    expect(JSON.parse(json.out[0] ?? '{}').checks).toEqual(report.checks);
  });
});

describe('doctor: Secrets', () => {
  const RAW = {
    server: { adminToken: '${ADMIN_TOKEN}' },
    payments: {
      x402: {
        payTo: '${MERCHANT_WALLET}',
        rpcUrl: '${RPC_URL:-https://default-rpc.example/DEFAULT-KEY}',
        facilitator: { token: '${FACILITATOR_TOKEN}' },
      },
    },
  };
  // The environment arrives the way the Config check reads it, through the
  // manifest fill, which leaves process.env untouched
  const secrets = (env: Record<string, string>, deps: Partial<DoctorDeps> = {}) =>
    doctor({
      fetchImpl: gatewayFetch(),
      loadConfig: async () => makeGatewayConfig(),
      readConfigFile: async () => RAW,
      fillEnvFromManifest: () => ({ env, filled: [], manifestFound: false }),
      ...deps,
    });

  it('FAILs naming every missing variable, and prints no value or default', async () => {
    const { report, check } = await secrets({ ADMIN_TOKEN: 'ADMIN-SECRET-VALUE' });
    expect(check('Secrets')).toEqual({
      name: 'Secrets',
      status: 'FAIL',
      detail:
        '2 missing (FACILITATOR_TOKEN, MERCHANT_WALLET); 1 set (ADMIN_TOKEN); 1 defaulted (RPC_URL)',
    });
    expect(report.exitCode).toBe(1);
    const text = createCapturingIo();
    printDoctorReport(report, text, false);
    const json = createCapturingIo();
    printDoctorReport(report, json, true);
    for (const output of [text.out.join('\n'), json.out.join('\n')]) {
      expect(output).not.toContain('ADMIN-SECRET-VALUE');
      expect(output).not.toContain('DEFAULT-KEY');
    }
  });

  it("passes when every variable resolves in the Config check's environment, a default included", async () => {
    const { check } = await secrets({
      ADMIN_TOKEN: 'a',
      MERCHANT_WALLET: 'b',
      FACILITATOR_TOKEN: '',
    });
    expect(check('Secrets')).toMatchObject({
      status: 'PASS',
      detail: '3 set (ADMIN_TOKEN, FACILITATOR_TOKEN, MERCHANT_WALLET); 1 defaulted (RPC_URL)',
    });
  });

  it('is INFO for a config that reads no variable', async () => {
    const { check } = await secrets(
      {},
      { readConfigFile: async () => ({ server: { port: 8080 } }) },
    );
    expect(check('Secrets')).toMatchObject({ status: 'INFO' });
  });

  it('WARNs, marked skipped, when the file cannot be read', async () => {
    const { check } = await secrets(
      {},
      {
        readConfigFile: async () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect(check('Secrets')).toEqual({
      name: 'Secrets',
      status: 'WARN',
      detail: 'skipped: config file unreadable',
      undetermined: 'skipped',
    });
  });

  it('is left out when a loader is injected without a reader', async () => {
    const { check } = await doctor({
      fetchImpl: gatewayFetch(),
      loadConfig: async () => makeGatewayConfig(),
    });
    expect(check('Secrets')).toBeUndefined();
  });

  it('reads the --config file by default', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'doctor-secrets-')), 'config.yaml');
    writeFileSync(file, 'server:\n  adminToken: ${DOCTOR_SECRETS_ONLY_VAR}\n');
    const report = await runDoctor(
      { gatewayUrl: GATEWAY, configPath: file },
      {
        fetchImpl: gatewayFetch(),
        createStore: () => makeFakeReceiptStore(),
        fillEnvFromManifest: (env) => ({ env, filled: [], manifestFound: false }),
        hasChainDeployScript: () => false,
      },
    );
    expect(report.checks.find((c) => c.name === 'Secrets')).toMatchObject({
      status: 'FAIL',
      detail: '1 missing (DOCTOR_SECRETS_ONLY_VAR)',
    });
  });
});
