import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { printDoctorReport, runDoctor } from '../../../src/cli/commands/doctor.js';
import { createCapturingIo } from '../../../src/cli/lib/io.js';
import { CommerceError } from '../../../src/core/index.js';
import {
  createFakeFetch,
  jsonResponse,
  makeFakeReceiptStore,
  makeGatewayConfig,
  makeResource,
} from './fixtures.js';

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
  // which would mask every other assertion in this file.
  asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  assetName: 'MockUSDC',
  assetVersion: '2',
  assetDecimals: 6,
  payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  maxTimeoutSeconds: 60,
  facilitator: { mode: 'local' as const, signerPrivateKey: '0xdeadbeef' },
};

/** `/.well-known/agent-commerce` body reporting the gateway's *live* x402 settlement config. */
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

describe('runDoctor — fully healthy', () => {
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

  it('completes in well under 5 seconds against healthy local dependencies', async () => {
    const start = Date.now();
    await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('runDoctor — degraded scenarios never hang and degrade gracefully', () => {
  it('FAILs Gateway (and downstream Protocols) when the gateway is unreachable, but completes quickly', async () => {
    const start = Date.now();
    const report = await runDoctor(
      { gatewayUrl: 'http://127.0.0.1:1' }, // nothing listens here
      {
        fetchImpl: createFakeFetch({}), // every URL "unreachable"
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    expect(Date.now() - start).toBeLessThan(5000);
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
    // `init --yes` writes 0x…dEaD, and the live cross-check compares config
    // against the gateway's echo of that same config — so everything agreed
    // and doctor reported 7/7 PASS for a deployment where no paid call can
    // succeed, because no token contract exists at that address.
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
    expect(report.exitCode).toBe(0); // a warning, not a failure — nothing is unsafe
  });

  it('FAILs Payments when the gateway positively reports x402 disabled', async () => {
    // Three situations used to collapse into one `undefined`: gateway down,
    // document malformed, and the gateway *saying* x402 is off. The third was
    // then printed as INFO "could not be verified" — but it was verified, and
    // it disagreed. Local config enabling x402 against a stale gateway running
    // with it off is the exact deployment mismatch this cross-check exists for.
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

  it('probes a kebab {param} at the URL the runtime builds, not the one the operator meant', async () => {
    // doctor carried its own `/\{[^}]+\}/g`, looser than the canonical
    // grammar. It substituted tokens the runtime left literal, so it probed
    // `/report/demo-check`, got 200, and certified as healthy a paid resource
    // that charged the buyer and then 404'd on `%7Breport-id%7D` every time.
    // Now both use `extractPathParameterNames`, so a token the runtime cannot
    // fill is one doctor cannot fill either.
    const probed: string[] = [];
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: createFakeFetch({
          [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
          [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
          [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse({}),
          // The URL the operator *meant*. Registering it is the point: if
          // doctor still substituted an unrecognised token it would hit this
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
                  // Not a legal parameter under the canonical grammar.
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
          'http://localhost:3000/api/report': () => jsonResponse({ report: 'ok' }),
          // weather's URL (.../weather/demo-check) is deliberately NOT registered.
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

  it('reports Payments as INFO when x402 is not configured, plus the planned-MPP INFO line', async () => {
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
    expect(mpp?.status).toBe('INFO');
    expect(mpp?.detail).toMatch(/planned/);
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
    expect(payments?.detail).not.toContain('0xdeadbeef');
  });

  // A false green: doctor reporting 7/7 PASS while the gateway is configured
  // with one MockUSDC address and local config resolves to another. A diagnostic that passes on a misconfigured
  // system is worse than no diagnostic.
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
        fetchImpl: createFakeFetch({}), // every URL rejects — gateway unreachable
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('INFO');
  });

  it('FAILs Payments when the gateway reaches and reports x402 DISABLED — this assertion used to demand INFO', async () => {
    // Deliberately inverted. The original reasoning — "a doctor
    // that fails on things it cannot check is untrustworthy" — is right, and
    // was applied to the wrong case: `enabled: false` is not something doctor
    // could not check, it is something it checked and found in conflict with
    // local config. The unverifiable cases (gateway down, malformed document,
    // absent `enabled`) are still INFO; the two tests above and below pin
    // both sides so this cannot silently flip back.
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch({
          [`${GATEWAY}/.well-known/agent-commerce`]: () =>
            jsonResponse(wellKnownBody({ enabled: false })),
        }),
        loadConfig: async () => makeGatewayConfig({ payments: { x402: X402_CONFIG } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const payments = report.checks.find((c) => c.name === 'Payments');
    expect(payments?.status).toBe('FAIL');
    expect(payments?.detail).toContain('reports x402 disabled');
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
  it('prints a human-readable report with PASS/FAIL labels and a score line', async () => {
    const report = await runDoctor(
      { gatewayUrl: GATEWAY },
      {
        fetchImpl: healthyFetch(),
        loadConfig: async () => makeGatewayConfig(),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const io = createCapturingIo();
    printDoctorReport(report, io, false);
    const text = io.out.join('\n');
    expect(text).toContain('Config');
    expect(text).toMatch(/Score: \d+\/\d+ checks passed/);
  });

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

  it('colours every status distinctly (PASS/WARN/FAIL/INFO all appear in one report)', () => {
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
    const text = io.out.join('\n');
    expect(text).toContain('PASS');
    expect(text).toContain('WARN');
    expect(text).toContain('FAIL');
    expect(text).toContain('INFO');
  });
});

describe('runDoctor — additional derivation and error-recovery branches', () => {
  it('derives the gateway URL from config.server when no --gateway is given', async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = createFakeFetch({
      'http://127.0.0.1:9090/health': () => {
        requestedUrl = 'http://127.0.0.1:9090/health';
        return jsonResponse({ status: 'ok' });
      },
      'http://127.0.0.1:9090/ready': () => jsonResponse({ status: 'ready' }),
    });
    await runDoctor(
      {},
      {
        fetchImpl,
        loadConfig: async () =>
          makeGatewayConfig({ server: { port: 9090, host: '0.0.0.0', allowedOrigins: [] } }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    expect(requestedUrl).toBe('http://127.0.0.1:9090/health');
  });

  it('uses config.server.host verbatim when it is not the 0.0.0.0 wildcard', async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = createFakeFetch({
      'http://gateway.internal:9090/health': () => {
        requestedUrl = 'http://gateway.internal:9090/health';
        return jsonResponse({ status: 'ok' });
      },
      'http://gateway.internal:9090/ready': () => jsonResponse({ status: 'ready' }),
    });
    await runDoctor(
      {},
      {
        fetchImpl,
        loadConfig: async () =>
          makeGatewayConfig({
            server: { port: 9090, host: 'gateway.internal', allowedOrigins: [] },
          }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    expect(requestedUrl).toBe('http://gateway.internal:9090/health');
  });

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
            },
          }),
        createStore: () => makeFakeReceiptStore(),
      },
    );
    const protocols = report.checks.find((c) => c.name === 'Protocols');
    expect(protocols?.detail).toBe('http=on mcp=off a2a=off');
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

  // Counting via listReceipts({ limit: 100_000 }) silently saturates at the
  // store's MAX_LIST_LIMIT clamp (500). doctor must report the exact total.
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
  // doctor, not just quietly logged.
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

  it('omits the undelivered parenthetical entirely when M is 0 — quiet in the common case', async () => {
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

describe('runDoctor — local chain manifest fill (docker vs. host env parity)', () => {
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

describe('runDoctor — Storage check does not create the store it is checking', () => {
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
        // No createStore override: the real src/storage/receipts
        // factory must never even be called for a path that doesn't exist.
        loadConfig: async () =>
          makeGatewayConfig({ storage: { receipts: { driver: 'sqlite', path: wrongPath } } }),
      },
    );

    const storage = report.checks.find((c) => c.name === 'Storage');
    expect(storage?.status).toBe('WARN');
    expect(storage?.detail).toContain(wrongPath);
    expect(storage?.detail).toContain('created automatically');
    // The actual proof: no directory, no database file, no WAL file.
    expect(existsSync(wrongPath)).toBe(false);
    expect(existsSync(join(dir, 'does-not-exist'))).toBe(false);
    expect(report.exitCode).toBe(0); // WARN, not FAIL
  });

  it('still opens, reports health and counts receipts when the store already exists on disk', async () => {
    const path = join(dir, 'receipts.sqlite');
    // Create it for real once, the way the gateway would on first start.
    const { createSqliteReceiptStore } = await import('../../../src/storage/receipts/index.js');
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

describe('runDoctor — A2A', () => {
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
    // alike; both must appear, named.
    expect(a2a?.detail).toContain('spec 1.0.0');
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
    for (const operation of ['SendStreamingMessage', 'GetTask', 'CancelTask', 'gRPC binding']) {
      expect(unsupported?.detail).toContain(operation);
    }
  });
});
