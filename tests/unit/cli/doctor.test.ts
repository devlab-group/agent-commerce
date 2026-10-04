import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AP2_UNSUPPORTED } from '../../../src/authorization/ap2/descriptor';
import { printDoctorReport, runDoctor } from '../../../src/cli/commands/doctor';
import type { GatewayConfig } from '../../../src/config';
import { CommerceError, type CommerceResource } from '../../../src/core';
import { A2A_UNSUPPORTED } from '../../../src/protocols/a2a/descriptor';
import { ACP_UNSUPPORTED } from '../../../src/protocols/acp/descriptor';
import {
  createCapturingIo,
  createFakeFetch,
  jsonResponse,
  makeFakeReceiptStore,
  makeGatewayConfig,
  makeResource,
} from './fixtures';

const GATEWAY = 'http://127.0.0.1:8080';

function healthyFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return createFakeFetch({
    [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
    [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
    [`${GATEWAY}/.well-known/agent-commerce`]: () =>
      jsonResponse({ merchant: { id: 'demo-merchant' } }),
    'http://localhost:3000/api/weather/demo-check': () => jsonResponse({ city: 'demo-check' }),
    ...overrides,
  });
}

const X402_CONFIG = {
  enabled: true,
  network: 'eip155:84532',
  rpcUrl: 'http://127.0.0.1:8545',
  // Deliberately NOT the init placeholder (0x…dEaD): doctor WARNs on that,
  // which would mask every other assertion in this file
  asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  assetName: 'MockUSDC',
  assetVersion: '2',
  assetDecimals: 6,
  payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  maxTimeoutSeconds: 60,
  facilitator: { mode: 'local' as const, signerPrivateKey: '0xdeadbeef' },
};

// `/.well-known/agent-commerce` body reporting the gateway's *live* x402 settlement config
function wellKnownBody(
  x402Overrides: Partial<{ asset: string; network: string; payTo: string; enabled: boolean }> = {},
) {
  return {
    merchant: { id: 'demo-merchant' },
    payments: {
      x402: {
        enabled: true,
        network: X402_CONFIG.network,
        asset: X402_CONFIG.asset,
        payTo: X402_CONFIG.payTo,
        ...x402Overrides,
      },
    },
  };
}

describe('runDoctor: a healthy deployment', () => {
  it('reports PASS for every non-INFO check and exit code 0', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig({ payments: {} }),
        createStore: () => makeFakeReceiptStore(),
      },
    );

    expect(report.exitCode).toBe(0);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(byName['Config']).toBe('PASS');
    expect(byName['Gateway']).toBe('PASS');
    expect(byName['Backend']).toBe('PASS');
    expect(byName['Protocols']).toBe('PASS');
    expect(byName['Storage']).toBe('PASS');
    expect(byName['Protocol versions']).toBe('PASS');
    expect(report.score.passed).toBe(report.score.total);
  });
});

describe('runDoctor: degraded scenarios report the failure', () => {
  it('FAILs Gateway (and downstream Protocols) when the gateway is unreachable', async () => {
    const report = await runDoctor(
      { gatewayUrl: 'http://127.0.0.1:1' }, // nothing listens here
      {
        fetchImpl: createFakeFetch({}), // every URL "unreachable"
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    expect(report.exitCode).toBe(1);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(byName['Gateway']).toBe('FAIL');
    expect(byName['Protocols']).toBe('FAIL');
    expect(byName['Protocol versions']).toBe('INFO');
  });

  it('WARNs Gateway when healthy but not ready', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/ready`]: () => jsonResponse({ error: 'starting up' }, 503),
        }),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const gateway = report.checks.find((c) => c.name === 'Gateway');
    expect(gateway?.status).toBe('WARN');
    // Config, Backend, Protocols, Storage and Protocol versions pass; INFO checks are not scored
    expect(report.score).toEqual({ passed: 5, total: 6 });
  });

  it('FAILs Config and WARNs downstream config-dependent checks when the config is invalid', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => {
          throw new CommerceError('CONFIG_INVALID', 'missing merchant');
        },
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(byName['Config']).toBe('FAIL');
    expect(byName['Backend']).toBe('WARN');
    expect(byName['Protocols']).toBe('WARN');
    expect(byName['Storage']).toBe('WARN');
    expect(report.exitCode).toBe(1);
  });

  it('falls back to http://localhost:8080 when config is invalid and no --gateway is given', async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = createFakeFetch({
      'http://localhost:8080/health': () => {
        requestedUrl = 'http://localhost:8080/health';
        return jsonResponse({ status: 'ok' });
      },
      'http://localhost:8080/ready': () => jsonResponse({ status: 'ready' }),
    });
    await runDoctor(
      {},
      {
        fetchImpl,
        loadConfig: async () => {
          throw new Error('bad config');
        },
        createStore: () => makeFakeReceiptStore(),
      },
    );
    expect(requestedUrl).toBe('http://localhost:8080/health');
  });

  it('WARNs when the configured asset is still the init placeholder', async () => {
    // The live cross-check alone would pass the placeholder (see the
    // placeholder branch of the Payments check in doctor.ts)
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () =>
          makeGatewayConfig({
            payments: {
              x402: { ...X402_CONFIG, asset: '0x000000000000000000000000000000000000dEaD' },
            },
          }),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('WARN');
    expect(payments?.detail).toContain('placeholder');
    expect(report.exitCode).toBe(0); // a warning, not a failure: nothing is unsafe
  });

  it('FAILs Payments when the gateway positively reports x402 disabled', async () => {
    // Gateway down and a malformed document cannot be judged, but the gateway
    // *saying* x402 is off was verified, and it disagrees: local config against
    // a stale gateway is the mismatch this cross-check exists for
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () =>
            jsonResponse({
              merchant: { id: 'demo-merchant' },
              payments: { x402: { enabled: false } },
            }),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('FAIL');
    expect(payments?.detail).toContain('reports x402 disabled');
  });

  it('control: a genuinely unverifiable gateway is still INFO, not FAIL', async () => {
    // A doctor that fails on what it cannot check is as untrustworthy as one
    // that passes on what it never checked. Absent `enabled` is "cannot tell".
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () =>
            jsonResponse({ merchant: { id: 'demo-merchant' }, payments: { x402: {} } }),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('INFO');
    expect(payments?.detail).toContain('could not be verified');
  });

  it('probes an illegal {param} at the URL the runtime builds, not the one the operator meant', async () => {
    // Doctor must leave `{report id}` literal, as the runtime does (see
    // substitutePathParams in doctor.ts)
    const probed: string[] = [];
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: createFakeFetch({
          [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
          [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
          [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse({}),
          // The URL the operator *meant*. Registering it is the point: if
          // doctor still substituted an unrecognized token it would hit this
          // and PASS.
          'http://localhost:3000/api/report/demo-check': () => {
            probed.push('substituted');
            return jsonResponse({ ok: true });
          },
        }),
        loadConfig: async () =>
          makeGatewayConfig({
            resources: [
              makeResource({
                id: 'report',
                handler: {
                  type: 'http',
                  method: 'GET',
                  // Not a legal parameter under the canonical grammar
                  url: 'http://localhost:3000/api/report/{report id}',
                },
              }),
            ],
          }),
      },
    );
    expect(probed).toEqual([]);
    expect(report.checks.find((c) => c.name === 'Backend')?.status).not.toBe('PASS');
  });

  it('control: a legal kebab {param} IS substituted, so ordinary REST still probes cleanly', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: createFakeFetch({
          [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
          [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
          [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse({}),
          'http://localhost:3000/api/report/demo-check': () => jsonResponse({ ok: true }),
        }),
        loadConfig: async () =>
          makeGatewayConfig({
            resources: [
              makeResource({
                id: 'report',
                handler: {
                  type: 'http',
                  method: 'GET',
                  url: 'http://localhost:3000/api/report/{report-id}',
                },
              }),
            ],
          }),
      },
    );
    expect(report.checks.find((c) => c.name === 'Backend')?.status).toBe('PASS');
  });

  it('WARNs Backend when only some resources are reachable', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: createFakeFetch({
          [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
          [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
          [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse({}),
          // Any HTTP answer, an error status included, shows the host is reachable
          'http://localhost:3000/api/report': () => jsonResponse({ error: 'not found' }, 404),
          // weather's URL (.../weather/demo-check) is deliberately NOT registered
        }),
        loadConfig: async () =>
          makeGatewayConfig({
            resources: [
              makeResource({
                id: 'weather',
                handler: {
                  type: 'http',
                  method: 'GET',
                  url: 'http://localhost:3000/api/weather/{city}',
                },
              }),
              makeResource({
                id: 'report',
                handler: { type: 'http', method: 'GET', url: 'http://localhost:3000/api/report' },
              }),
            ],
          }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const backend = report.checks.find((c) => c.name === 'Backend');
    expect(backend?.status).toBe('WARN');
    expect(backend?.detail).toContain('1/2');
  });

  it('reports Backend as INFO when there are no resources configured', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig({ resources: [] }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const backend = report.checks.find((c) => c.name === 'Backend');
    expect(backend?.status).toBe('INFO');
  });

  it('reports Payments and Payments (MPP) as INFO when neither rail is configured', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig({ payments: {} }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    const mpp = report.checks.find((c) => c.name === 'Payments (MPP)');
    expect(payments?.status).toBe('INFO');
    expect(mpp).toMatchObject({ status: 'INFO', detail: 'MPP not configured' });
  });

  describe('Payments (MPP)', () => {
    const MPP_CONFIG = {
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
        url: 'https://facilitator.example/tenant',
        auth: { type: 'bearer' as const, token: 'FACILITATOR-TOKEN' },
      },
    };
    const liveMpp = (overrides: Record<string, unknown> = {}) => ({
      merchant: { id: 'demo-merchant' },
      payments: {
        mpp: {
          enabled: true,
          network: 'eip155:84532',
          asset: MPP_CONFIG.asset,
          recipient: MPP_CONFIG.recipient,
          ...overrides,
        },
      },
    });
    const mppCheck = async (live: Record<string, unknown>) => {
      const report = await runDoctor(
        { gatewayUrl: GATEWAY },
        {
          fetchImpl: healthyFetch({
            [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse(live),
          }),
          loadConfig: async () => makeGatewayConfig({ payments: { mpp: MPP_CONFIG } }),
          createStore: () => makeFakeReceiptStore(),
        },
      );
      return report.checks.find((c) => c.name === 'Payments (MPP)');
    };

    it('passes on matching config while masking the recipient', async () => {
      const check = await mppCheck(liveMpp());
      expect(check?.status).toBe('PASS');
      expect(check?.detail).toMatch(/charge\/evm\/authorization/);
      expect(check?.detail).toContain('TESTNET on Base Sepolia (eip155:84532)');
      expect(check?.detail).toContain('facilitator=remote (auth=bearer)');
      expect(check?.detail).toMatch(/draft-httpauth-payment-01@806fdb8/);
      expect(check?.detail).toMatch(/mppx 0\.13\.1/);
      expect(check?.detail).not.toContain(MPP_CONFIG.recipient);
    });

    it('never prints a credential or an RPC URL of either rail, in text or JSON', async () => {
      const report = await runDoctor(
        { gatewayUrl: GATEWAY },
        {
          fetchImpl: healthyFetch(),
          loadConfig: async () =>
            makeGatewayConfig({
              server: {
                port: 8080,
                host: '0.0.0.0',
                allowedOrigins: [],
                adminToken: 'ADMIN-TOKEN-0123456789',
              },
              payments: {
                x402: {
                  ...X402_CONFIG,
                  rpcUrl: 'https://rpc.example/v2/X402-RPC-KEY',
                  payTo: MPP_CONFIG.recipient,
                  facilitator: {
                    mode: 'remote',
                    url: 'https://facilitator.example/x402-tenant',
                    auth: { type: 'bearer', token: 'X402-BEARER-TOKEN' },
                  },
                },
                mpp: MPP_CONFIG,
              },
            }),
          createStore: () => makeFakeReceiptStore(),
        },
      );
      const text = createCapturingIo();
      printDoctorReport(report, text, false);
      const json = createCapturingIo();
      printDoctorReport(report, json, true);
      const printed = [...text.out, ...json.out].join('\n');

      // Both rails were described, so their settings reached the output path
      expect(printed).toContain('x402 v2 (scheme=exact) enabled');
      expect(printed).toContain('MPP charge/evm/authorization enabled');
      for (const secret of [
        'ADMIN-TOKEN',
        'RPC-KEY',
        'tenant',
        'X402-BEARER-TOKEN',
        'FACILITATOR-TOKEN',
        'CHALLENGE-SECRET',
      ]) {
        expect(printed).not.toContain(secret);
      }
    });

    it('fails when the running gateway pays another recipient', async () => {
      const check = await mppCheck(
        liveMpp({ recipient: '0x2222222222222222222222222222222222222222' }),
      );
      expect(check?.status).toBe('FAIL');
      expect(check?.detail).toMatch(/^recipient: gateway is using 0x2222/);
    });

    it('fails when the running gateway reports MPP disabled', async () => {
      expect((await mppCheck(liveMpp({ enabled: false })))?.status).toBe('FAIL');
    });
  });

  describe('Deployment mode', () => {
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const MERCHANT = '0x1111111111111111111111111111111111111111';
    const remote = (auth: { type: 'none' } | { type: 'bearer'; token: string }) => ({
      mode: 'remote' as const,
      url: 'https://facilitator.example',
      auth,
    });
    const mainnetX402 = (auth: Parameters<typeof remote>[0]) => ({
      ...X402_CONFIG,
      network: 'eip155:8453',
      asset: USDC,
      assetName: 'USD Coin',
      payTo: MERCHANT,
      allowMainnet: true,
      facilitator: remote(auth),
    });
    const mainnetMpp = (auth: Parameters<typeof remote>[0]) => ({
      enabled: true,
      network: 'eip155:8453' as const,
      rpcUrl: 'https://base.example',
      asset: USDC,
      assetName: 'USD Coin',
      assetVersion: '2',
      recipient: MERCHANT,
      realm: 'api.example.com',
      challengeSecret: 'x'.repeat(32),
      allowMainnet: true,
      facilitator: remote(auth),
    });
    const checksFor = async (payments: Record<string, unknown>, prefix = 'Mainnet safety') => {
      const report = await runDoctor(
        { gatewayUrl: GATEWAY },
        {
          fetchImpl: healthyFetch(),
          loadConfig: async () => makeGatewayConfig({ payments } as Partial<GatewayConfig>),
          createStore: () => makeFakeReceiptStore(),
        },
      );
      return report.checks.filter((c) => c.name.startsWith(prefix));
    };
    const testnet = { network: 'eip155:84532', allowMainnet: false };

    // Chain id 84532 is both the local dev chain and public Base Sepolia, so the
    // facilitator mode decides which one the report names
    it.each([
      [
        'a local facilitator on 84532',
        X402_CONFIG,
        'LOCAL dev chain (eip155:84532, chain id shared with Base Sepolia), destination=0xf39F…2266, facilitator=local (in-process)',
      ],
      [
        'a remote facilitator on 84532',
        { ...mainnetX402({ type: 'bearer', token: 'T' }), ...testnet },
        'TESTNET on Base Sepolia (eip155:84532), destination=0x1111…1111, facilitator=remote (auth=bearer)',
      ],
      [
        'a remote facilitator on 8453',
        mainnetX402({ type: 'bearer', token: 'T' }),
        'LIVE MAINNET MODE - REAL FUNDS on Base (eip155:8453), destination=0x1111…1111, facilitator=remote (auth=bearer)',
      ],
    ])('names where x402 settles with %s', async (_label, x402, where) => {
      const [payments] = await checksFor({ x402 }, 'Payments');
      expect(payments?.detail).toContain(`x402 v2 (scheme=exact) enabled - ${where}`);
    });

    it('reports x402 on mainnet, and WARNs for an unauthenticated facilitator', async () => {
      const [withCredential] = await checksFor({
        x402: mainnetX402({ type: 'bearer', token: 'T' }),
      });
      expect(withCredential).toMatchObject({ name: 'Mainnet safety', status: 'INFO' });
      expect(withCredential?.detail).toMatch(/non-development payTo/);
      const [anonymous] = await checksFor({ x402: mainnetX402({ type: 'none' }) });
      expect(anonymous).toMatchObject({ name: 'Mainnet safety', status: 'WARN' });
      expect(anonymous?.detail).toMatch(/anonymous-access limits apply/);
    });

    it('reports MPP on mainnet the same way, naming its recipient', async () => {
      const [withCredential] = await checksFor({
        mpp: mainnetMpp({ type: 'bearer', token: 'T' }),
      });
      expect(withCredential).toMatchObject({ name: 'Mainnet safety (MPP)', status: 'INFO' });
      expect(withCredential?.detail).toMatch(/non-development recipient/);
      const [anonymous] = await checksFor({ mpp: mainnetMpp({ type: 'none' }) });
      expect(anonymous).toMatchObject({ name: 'Mainnet safety (MPP)', status: 'WARN' });
    });

    it('stays silent on the local chain and on a testnet', async () => {
      expect(await checksFor({ x402: X402_CONFIG })).toEqual([]);
      expect(
        await checksFor({
          x402: { ...mainnetX402({ type: 'none' }), ...testnet },
          mpp: { ...mainnetMpp({ type: 'none' }), ...testnet },
        }),
      ).toEqual([]);
    });
  });

  it('reports Payments as PASS with a masked destination when x402 is enabled and matches the gateway', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse(wellKnownBody()),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('PASS');
    expect(payments?.detail).toContain('0xf39F…2266');
    expect(JSON.stringify(report)).not.toContain(X402_CONFIG.facilitator.signerPrivateKey);
  });

  // Without this check doctor would pass while the gateway uses one MockUSDC
  // address and local config resolves to another
  it('FAILs Payments, naming both values, when the gateway is using a different asset than local config resolves to', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () =>
            jsonResponse(wellKnownBody({ asset: '0x1111111111111111111111111111111111111111' })),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('FAIL');
    expect(payments?.detail).toContain('0x1111111111111111111111111111111111111111');
    expect(payments?.detail).toContain(X402_CONFIG.asset);
    expect(payments?.detail).toContain('chain:deploy');
    expect(report.exitCode).toBe(1);
  });

  it('FAILs Payments when the gateway is using a different network than local config resolves to', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () =>
            jsonResponse(wellKnownBody({ network: 'base' })),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('FAIL');
    expect(payments?.detail).toContain('eip155:84532');
    expect(payments?.detail).toContain('"base"');
  });

  it('FAILs Payments when the gateway is using a different payTo than local config resolves to', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () =>
            jsonResponse(wellKnownBody({ payTo: '0x2222222222222222222222222222222222222222' })),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('FAIL');
    expect(payments?.detail).toContain('0x2222222222222222222222222222222222222222');
  });

  it('does not FAIL on an address casing difference alone (checksum-insensitive)', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () =>
            jsonResponse(
              wellKnownBody({ asset: X402_CONFIG.asset.toUpperCase().replace('0X', '0x') }),
            ),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('PASS');
  });

  it('reports Payments as INFO (not FAIL) when x402 is configured but the gateway is unreachable', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: createFakeFetch({}), // every URL rejects: gateway unreachable
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('INFO');
  });

  it('FAILs Storage when the receipt store reports a fail health status', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () =>
          makeFakeReceiptStore({
            health: async () => ({
              status: 'fail',
              detail: 'schema mismatch',
              checkedAt: '2026-01-01T00:00:00.000Z',
            }),
          }),
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('FAIL');
    expect(report.exitCode).toBe(1);
  });

  it('FAILs Storage when opening the store throws', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => {
          throw new Error('disk full');
        },
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('FAIL');
    expect(storage?.detail).toContain('disk full');
  });
});

describe('printDoctorReport', () => {
  it('emits machine-readable JSON with --json', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const io = createCapturingIo();
    printDoctorReport(report, io, true);
    expect(io.out).toHaveLength(1);
    const parsed = JSON.parse(io.out[0] ?? '{}');
    expect(parsed).toEqual(report);
  });

  it('prints one line per check with its status, name and detail, then the score', () => {
    const io = createCapturingIo();
    printDoctorReport(
      {
        checks: [
          { name: 'A', status: 'PASS', detail: 'ok' },
          { name: 'B', status: 'WARN', detail: 'meh' },
          { name: 'C', status: 'FAIL', detail: 'bad' },
          { name: 'D', status: 'INFO', detail: 'fyi' },
        ],
        score: { passed: 1, total: 3 },
        exitCode: 1,
      },
      io,
      false,
    );
    // Colors depend on the terminal, so compare the plain text
    expect(io.out.map((line) => stripVTControlCharacters(line))).toEqual([
      `PASS  ${'A'.padEnd(20)} ok`,
      `WARN  ${'B'.padEnd(20)} meh`,
      `FAIL  ${'C'.padEnd(20)} bad`,
      `INFO  ${'D'.padEnd(20)} fyi`,
      '',
      'Score: 1/3 checks passed',
    ]);
  });
});

describe('runDoctor: additional derivation and error-recovery branches', () => {
  // A wildcard bind address is probed on loopback, and an IPv6 host is bracketed
  it.each([
    ['0.0.0.0', 'http://127.0.0.1:9090'],
    ['::', 'http://[::1]:9090'],
    ['::1', 'http://[::1]:9090'],
    ['gateway.internal', 'http://gateway.internal:9090'],
  ])(
    'derives the gateway URL from config.server.host %s when no --gateway is given',
    async (host, base) => {
      const report = await runDoctor(
        {},
        {
          fetchImpl: createFakeFetch({
            [`${base}/health`]: () => jsonResponse({ status: 'ok' }),
            [`${base}/ready`]: () => jsonResponse({ status: 'ready' }),
          }),
          loadConfig: async () =>
            makeGatewayConfig({ server: { port: 9090, host, allowedOrigins: [] } }),
          createStore: () => makeFakeReceiptStore(),
        },
      );
      expect(report.checks.find((c) => c.name === 'Gateway')).toMatchObject({
        status: 'PASS',
        detail: `healthy and ready at ${base}`,
      });
    },
  );

  it('strips a trailing slash from an explicit --gateway URL', async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = createFakeFetch({
      'http://example.test/health': () => {
        requestedUrl = 'http://example.test/health';
        return jsonResponse({ status: 'ok' });
      },
      'http://example.test/ready': () => jsonResponse({ status: 'ready' }),
    });
    await runDoctor(
      { gatewayUrl: 'http://example.test/' },
      {
        fetchImpl,
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    expect(requestedUrl).toBe('http://example.test/health');
  });

  it('FAILs Config with a stringified detail when a non-Error value is thrown', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => {
          throw 'a plain string failure';
        },
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const config = report.checks.find((c) => c.name === 'Config');
    expect(config?.status).toBe('FAIL');
    expect(config?.detail).toBe('a plain string failure');
  });

  it('FAILs Gateway with an HTTP-status detail (not a network error) when /health responds non-2xx', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: createFakeFetch({
          [`${GATEWAY}/health`]: () => jsonResponse({ error: 'internal' }, 500),
        }),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const gateway = report.checks.find((c) => c.name === 'Gateway');
    expect(gateway?.status).toBe('FAIL');
    expect(gateway?.detail).toContain('HTTP 500');
  });

  it('reports Protocols detail with mcp "off" and no mount path when mcp is disabled', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () =>
          makeGatewayConfig({
            protocols: {
              http: { enabled: true },
              mcp: { enabled: false, mountPath: '/mcp' },
              a2a: { enabled: false, mountPath: '/a2a' },
              acp: { enabled: false, mountPath: '/acp' },
            },
          }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const protocols = report.checks.find((c) => c.name === 'Protocols');
    expect(protocols?.detail).toBe('http=on mcp=off a2a=off acp=off');
  });

  it('reports Storage as WARN when the receipt store health check itself warns', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () =>
          makeFakeReceiptStore({
            health: async () => ({
              status: 'warn',
              detail: 'nearly full',
              checkedAt: '2026-01-01T00:00:00.000Z',
            }),
          }),
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('WARN');
    expect(report.exitCode).toBe(0); // WARN alone does not fail the overall exit code
  });

  it('still reports a receipt count of undefined-tolerant Storage PASS when countReceipts throws', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () =>
          makeFakeReceiptStore({
            countReceipts: async () => {
              throw new Error('countReceipts boom');
            },
          }),
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('PASS');
    expect(storage?.detail).not.toContain('receipts=');
  });

  // listReceipts clamps to the store's MAX_LIST_LIMIT (500), so a count taken
  // from it saturates. doctor must report the exact total.
  it('reports the exact receipt count via countReceipts, past what listReceipts would ever return', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () =>
          makeFakeReceiptStore({
            countReceipts: async () => 1200,
            listReceipts: async () => [], // deliberately not consulted for the count
          }),
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.detail).toContain('receipts=1200');
  });

  // A paid-but-undelivered purchase must be visible to an operator running
  // doctor, not just quietly logged
  it('reports "(M undelivered)" alongside the receipt count when M > 0', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () =>
          makeFakeReceiptStore({
            countReceipts: async () => 1200,
            countUndeliveredReceipts: async () => 7,
          }),
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.detail).toContain('receipts=1200 (7 undelivered)');
  });

  it('omits the undelivered parenthetical when M is 0, the common case', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () =>
          makeFakeReceiptStore({
            countReceipts: async () => 1200,
            countUndeliveredReceipts: async () => 0,
          }),
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.detail).toContain('receipts=1200');
    expect(storage?.detail).not.toContain('undelivered');
  });

  it('still reports the receipt count when countUndeliveredReceipts throws', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () =>
          makeFakeReceiptStore({
            countReceipts: async () => 1200,
            countUndeliveredReceipts: async () => {
              throw new Error('countUndeliveredReceipts boom');
            },
          }),
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('PASS');
    expect(storage?.detail).toContain('receipts=1200');
    expect(storage?.detail).not.toContain('undelivered');
  });
});

describe('runDoctor: local chain manifest fill (docker vs. host env parity)', () => {
  it('passes the filled env to loadConfig and notes it in the Config check detail', async () => {
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async (options) => {
          receivedEnv = options?.env;
          return makeGatewayConfig({ payments: {} });
        },
        createStore: () => makeFakeReceiptStore(),
        fillEnvFromManifest: () => ({
          env: { X402_ASSET: '0xfilled' },
          filled: ['X402_ASSET'],
          manifestFound: true,
        }),
      },
    );
    const config = report.checks.find((c) => c.name === 'Config');
    expect(config?.status).toBe('PASS');
    expect(config?.detail).toContain('.deploy/local.json');
    expect(config?.detail).toContain('X402_ASSET');
    expect(receivedEnv?.['X402_ASSET']).toBe('0xfilled');
  });

  it('adds a "run npm run chain:deploy" hint to the FAIL detail when no manifest was found for a fillable variable', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => {
          throw new CommerceError(
            'CONFIG_INVALID',
            'Unresolved environment variable "${X402_ASSET}" referenced at config path "$.payments.x402.asset"',
            { details: { variable: 'X402_ASSET', path: '$.payments.x402.asset' } },
          );
        },
        createStore: () => makeFakeReceiptStore(),
        fillEnvFromManifest: () => ({ env: process.env, filled: [], manifestFound: false }),
      },
    );
    const config = report.checks.find((c) => c.name === 'Config');
    expect(config?.status).toBe('FAIL');
    expect(config?.detail).toContain('npm run chain:deploy');
  });

  it('does not add the hint when a manifest was found (a real config problem, not a missing deployment)', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => {
          throw new CommerceError(
            'CONFIG_INVALID',
            'Unresolved environment variable "${X402_ASSET}" referenced at config path "$.payments.x402.asset"',
            { details: { variable: 'X402_ASSET', path: '$.payments.x402.asset' } },
          );
        },
        createStore: () => makeFakeReceiptStore(),
        fillEnvFromManifest: () => ({ env: process.env, filled: [], manifestFound: true }),
      },
    );
    const config = report.checks.find((c) => c.name === 'Config');
    expect(config?.detail).not.toContain('npm run chain:deploy');
  });
});

describe('runDoctor: the Storage check does not create the store it checks', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-commerce-doctor-storage-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('WARNs on a store path that does not exist yet, and creates nothing on disk', async () => {
    const wrongPath = join(dir, 'does-not-exist', 'receipts.sqlite');
    expect(existsSync(wrongPath)).toBe(false);

    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        // No createStore override: the real src/storage/receipts factory must
        // never be called for a path that does not exist
        loadConfig: async () =>
          makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path: wrongPath } } }),
      },
    );

    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('WARN');
    expect(storage?.detail).toContain(wrongPath);
    expect(storage?.detail).toContain('created when the gateway starts');
    // The proof: no directory, no database file, no WAL file
    expect(existsSync(wrongPath)).toBe(false);
    expect(existsSync(join(dir, 'does-not-exist'))).toBe(false);
    expect(report.exitCode).toBe(0); // WARN, not FAIL
  });

  it('still opens, reports health and counts receipts when the store already exists on disk', async () => {
    const path = join(dir, 'receipts.sqlite');
    // Create it for real once, the way the gateway would on first start
    const { createSqliteReceiptStore } = await import('../../../src/storage/receipts');
    const seed = createSqliteReceiptStore({ path });
    await seed.init();
    await seed.close();
    expect(existsSync(path)).toBe(true);

    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () =>
          makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path } } }),
      },
    );

    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('PASS');
    expect(storage?.detail).toContain('receipts=0');
  });

  it('still works on:memory:, which never exists on disk by definition', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(), // default storage.receipts.path is ':memory:'
      },
    );
    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('PASS');
  });
});

describe('runDoctor: A2A', () => {
  it('reports A2A as disabled by default', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const a2a = report.checks.find((c) => c.name === 'A2A');
    expect(a2a?.status).toBe('INFO');
    expect(a2a?.detail).toBe('disabled');
    expect(report.checks.find((c) => c.name === 'A2A unsupported')).toBeUndefined();
  });

  it('reports the spec revision, negotiation version, binding, mount and card path', async () => {
    const base = makeGatewayConfig();
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => ({
          ...base,
          protocols: { ...base.protocols, a2a: { enabled: true, mountPath: '/agents/a2a' } },
        }),
        createStore: () => makeFakeReceiptStore(),
      },
    );

    const a2a = report.checks.find((c) => c.name === 'A2A');
    expect(a2a?.status).toBe('PASS');
    // Spec revision and negotiation version are different values that look
    // alike; both must appear, named
    expect(a2a?.detail).toContain('spec 1.0.1');
    expect(a2a?.detail).toContain('protocol 1.0');
    expect(a2a?.detail).toContain('binding JSONRPC');
    expect(a2a?.detail).toContain('mount /agents/a2a');
    expect(a2a?.detail).toContain('card /.well-known/agent-card.json');
    expect(a2a?.detail).toContain('experimental');

    const protocols = report.checks.find((c) => c.name === 'Protocols');
    expect(protocols?.detail).toContain('a2a=on (/agents/a2a)');
  });

  it('lists every unsupported A2A operation in full', async () => {
    const base = makeGatewayConfig();
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => ({
          ...base,
          protocols: { ...base.protocols, a2a: { enabled: true, mountPath: '/a2a' } },
        }),
        createStore: () => makeFakeReceiptStore(),
      },
    );

    const unsupported = report.checks.find((c) => c.name === 'A2A unsupported');
    expect(unsupported?.status).toBe('INFO');
    expect(unsupported?.detail).toBe(A2A_UNSUPPORTED.join(', '));
    for (const operation of ['SendStreamingMessage', 'GetTask', 'CancelTask', 'gRPC binding']) {
      expect(unsupported?.detail).toContain(operation);
    }
  });
});

describe('runDoctor: ACP', () => {
  const OPERATIONS = {
    createCheckoutSession: 'acp_create',
    updateCheckoutSession: 'acp_update',
    getCheckoutSession: 'acp_get',
    completeCheckoutSession: 'acp_complete',
    cancelCheckoutSession: 'acp_cancel',
  };

  function checkoutResource(id: string): CommerceResource {
    return {
      id,
      name: id,
      handler: { type: 'http', method: 'POST', url: `http://backend.local/${id}` },
      pricing: { type: 'free' },
      exposedVia: ['acp'],
      paymentMethods: [],
    };
  }

  async function acpReport(
    acp: unknown,
    resources?: readonly CommerceResource[],
  ): Promise<Awaited<ReturnType<typeof runDoctor>>> {
    const base = makeGatewayConfig();
    return runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => ({
          ...base,
          protocols: { ...base.protocols, acp: acp as GatewayConfig['protocols']['acp'] },
          resources: resources ?? Object.values(OPERATIONS).map(checkoutResource),
        }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
  }

  function enabledAcp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      enabled: true,
      mountPath: '/acp',
      auth: { type: 'bearer', token: 'super-secret-acp-token' },
      idempotency: { path: ':memory:', retentionHours: 24 },
      checkout: { operations: OPERATIONS },
      ...overrides,
    };
  }

  it('reports ACP as disabled without any further ACP checks', async () => {
    const report = await acpReport({ enabled: false, mountPath: '/acp' }, []);

    expect(report.checks.find((c) => c.name === 'ACP')?.detail).toBe('disabled');
    for (const name of ['ACP auth', 'ACP idempotency', 'ACP checkout mapping', 'ACP unsupported']) {
      expect(report.checks.find((c) => c.name === name)).toBeUndefined();
    }
  });

  it('reports the pinned snapshot, the API version, the mount and the discovery path', async () => {
    const report = await acpReport(enabledAcp({ mountPath: '/agents/acp' }));

    const acp = report.checks.find((c) => c.name === 'ACP');
    expect(acp?.status).toBe('PASS');
    expect(acp?.detail).toContain('experimental');
    expect(acp?.detail).toContain('spec 2026-04-17');
    expect(acp?.detail).toContain('API-Version 2026-04-17');
    expect(acp?.detail).toContain('service checkout');
    expect(acp?.detail).toContain('mount /agents/acp');
    expect(acp?.detail).toContain('/.well-known/acp.json');
    expect(report.checks.find((c) => c.name === 'Protocols')?.detail).toContain(
      'acp=on (/agents/acp)',
    );
  });

  // The one thing this report must never print
  it('states that a bearer token is configured without printing it', async () => {
    const report = await acpReport(enabledAcp());

    const auth = report.checks.find((c) => c.name === 'ACP auth');
    expect(auth?.status).toBe('PASS');
    expect(auth?.detail).toContain('bearer');
    expect(JSON.stringify(report)).not.toContain('super-secret-acp-token');
  });

  it('warns that an in-memory idempotency store loses replay protection', async () => {
    const report = await acpReport(enabledAcp());

    const idempotency = report.checks.find((c) => c.name === 'ACP idempotency');
    expect(idempotency?.status).toBe('WARN');
    expect(idempotency?.detail).toContain('retention 24h');
  });

  it('passes the mapping check when all five resources are free and acp-exposed', async () => {
    const report = await acpReport(enabledAcp());

    const mapping = report.checks.find((c) => c.name === 'ACP checkout mapping');
    expect(mapping?.status).toBe('PASS');
    expect(mapping?.detail).toContain('acp_complete');
  });

  it.each([
    [
      'a resource that does not exist',
      Object.values(OPERATIONS).slice(1).map(checkoutResource),
      'does not exist',
    ],
    [
      'a resource that is not exposed via acp',
      Object.values(OPERATIONS).map((id) =>
        id === 'acp_get'
          ? { ...checkoutResource(id), exposedVia: ['http' as const] }
          : checkoutResource(id),
      ),
      'not exposed via acp',
    ],
    [
      'a resource with a price',
      Object.values(OPERATIONS).map((id) =>
        id === 'acp_complete'
          ? {
              ...checkoutResource(id),
              pricing: { type: 'fixed' as const, amount: '0.01', currency: 'USDC' },
            }
          : checkoutResource(id),
      ),
      'not free to invoke',
    ],
    [
      'a free resource that still names a payment method',
      Object.values(OPERATIONS).map((id) =>
        id === 'acp_complete'
          ? { ...checkoutResource(id), paymentMethods: ['x402' as const] }
          : checkoutResource(id),
      ),
      'not free to invoke',
    ],
  ])('fails the mapping check for %s', async (_label, resources, expected) => {
    const report = await acpReport(enabledAcp(), resources);

    const mapping = report.checks.find((c) => c.name === 'ACP checkout mapping');
    expect(mapping?.status).toBe('FAIL');
    expect(mapping?.detail).toContain(expected);
  });

  it('lists every unsupported ACP capability in full', async () => {
    const report = await acpReport(enabledAcp());

    const unsupported = report.checks.find((c) => c.name === 'ACP unsupported');
    expect(unsupported?.status).toBe('INFO');
    expect(unsupported?.detail).toBe(ACP_UNSUPPORTED.join(', '));
    for (const capability of [
      'carts service',
      'feed service',
      'delegate_payment',
      'webhooks',
      'ACP MCP transport binding',
    ]) {
      expect(unsupported?.detail).toContain(capability);
    }
  });
});

describe('runDoctor: AP2', () => {
  const KEY = {
    kty: 'EC',
    crv: 'P-256',
    // RFC 7515 A.3.1's public P-256 key. A published test vector, not a key
    // anything here can sign with.
    x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  };

  function enabledAp2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      enabled: true,
      specVersion: '0.2.0',
      mode: 'direct',
      trust: {
        mandateIssuers: [
          {
            issuer: 'https://surface.example',
            audience: 'merchant.example',
            keys: [{ kid: 'mandate-2026-01', jwk: KEY }],
          },
        ],
        checkoutIssuers: [
          {
            issuer: 'https://merchant.example',
            audience: 'agent-commerce',
            keys: [{ kid: 'checkout-2026-01', jwk: KEY }],
          },
        ],
      },
      clockSkewSeconds: 60,
      replay: { path: ':memory:' },
      ...overrides,
    };
  }

  function gatedResource(): CommerceResource {
    return {
      id: 'market_report',
      name: 'Market Report',
      handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
      pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
      exposedVia: ['http'],
      paymentMethods: ['x402'],
      authorization: { required: ['ap2'] },
    };
  }

  async function ap2Report(
    ap2: unknown,
    resources: readonly CommerceResource[] = [gatedResource()],
  ): Promise<Awaited<ReturnType<typeof runDoctor>>> {
    const base = makeGatewayConfig();
    return runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => ({
          ...base,
          resources,
          ...(ap2 === undefined
            ? {}
            : {
                authorization: { ap2: ap2 as NonNullable<GatewayConfig['authorization']>['ap2'] },
              }),
        }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
  }

  it('reports AP2 as disabled without any further AP2 checks', async () => {
    const report = await ap2Report({ enabled: false }, []);

    expect(report.checks.find((c) => c.name === 'AP2')?.detail).toBe('disabled');
    for (const name of ['AP2 trust', 'AP2 replay store', 'AP2 resources', 'AP2 unsupported']) {
      expect(report.checks.find((c) => c.name === name)).toBeUndefined();
    }
  });

  it('reports AP2 as disabled when no authorization block is configured at all', async () => {
    const report = await ap2Report(undefined, []);

    expect(report.checks.find((c) => c.name === 'AP2')?.detail).toBe('disabled');
  });

  it('reports the pinned spec, the mode, the mandate type and the profile', async () => {
    const report = await ap2Report(enabledAp2());

    const ap2 = report.checks.find((c) => c.name === 'AP2');
    expect(ap2?.status).toBe('PASS');
    expect(ap2?.detail).toContain('experimental');
    expect(ap2?.detail).toContain('spec 0.2.0');
    expect(ap2?.detail).toContain('mode direct');
    expect(ap2?.detail).toContain('mandate.checkout.1');
    expect(ap2?.detail).toContain('agent-commerce/ap2/checkout/v1');
    expect(ap2?.detail).toContain('clock skew 60s');
  });

  it('names the trusted issuers and how many keys each has, never a key', async () => {
    const report = await ap2Report(enabledAp2());

    const trust = report.checks.find((c) => c.name === 'AP2 trust');
    expect(trust?.detail).toContain('mandate issuers: https://surface.example (1 key)');
    expect(trust?.detail).toContain('checkout issuers: https://merchant.example (1 key)');
    // Key material is public, but it is trust policy nobody asked this report
    // to print, and a report is pasted into issues
    expect(JSON.stringify(report)).not.toContain(KEY.x);
    expect(JSON.stringify(report)).not.toContain(KEY.y);
  });

  it('warns that an in-memory replay store forgets every spent mandate', async () => {
    const report = await ap2Report(enabledAp2());

    const replay = report.checks.find((c) => c.name === 'AP2 replay store');
    expect(replay?.status).toBe('WARN');
    expect(replay?.detail).toContain('in-memory');
  });

  it('warns when a store file does not exist yet, without creating one', async () => {
    const path = join(tmpdir(), `ap2-doctor-${Date.now()}.db`);
    const report = await ap2Report(enabledAp2({ replay: { path } }));

    const replay = report.checks.find((c) => c.name === 'AP2 replay store');
    expect(replay?.status).toBe('WARN');
    expect(existsSync(path)).toBe(false);
  });

  // Root bypasses file permissions, so a read-only file stays writable for it
  it.skipIf(process.getuid?.() === 0)(
    'fails a store file that exists but is not writable',
    async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'ap2-doctor-')), 'replay.db');
      writeFileSync(path, '');
      const writable = await ap2Report(enabledAp2({ replay: { path } }));
      expect(writable.checks.find((c) => c.name === 'AP2 replay store')?.status).toBe('PASS');

      chmodSync(path, 0o444);
      const report = await ap2Report(enabledAp2({ replay: { path } }));
      const replay = report.checks.find((c) => c.name === 'AP2 replay store');
      expect(replay?.status).toBe('FAIL');
      expect(replay?.detail).toContain('is not writable');
      expect(report.exitCode).toBe(1);
    },
  );

  it('names the resources a mandate now gates', async () => {
    const report = await ap2Report(enabledAp2());

    const resources = report.checks.find((c) => c.name === 'AP2 resources');
    expect(resources?.status).toBe('PASS');
    expect(resources?.detail).toBe('market_report');
  });

  it('warns when AP2 is enabled but gates nothing', async () => {
    const report = await ap2Report(enabledAp2(), []);

    const resources = report.checks.find((c) => c.name === 'AP2 resources');
    expect(resources?.status).toBe('WARN');
    expect(resources?.detail).toContain('no resource requires it');
  });

  it('lists what AP2 does not do in full, rather than as a count', async () => {
    const report = await ap2Report(enabledAp2());

    const unsupported = report.checks.find((c) => c.name === 'AP2 unsupported');
    expect(unsupported?.detail).toBe(AP2_UNSUPPORTED.join(', '));
    for (const capability of [
      'autonomous mode',
      'open checkout mandates (mandate.checkout.open.1)',
      'spending constraint evaluation',
      'JWKS and any key discovery by URL (jku, x5u)',
      'AP2 over the ACP checkout adapter',
    ]) {
      expect(unsupported?.detail).toContain(capability);
    }
  });
});
