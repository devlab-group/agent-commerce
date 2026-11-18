// `doctor --registry`: the live MCP Registry listing compared with config, through a fake fetch
import { describe, expect, it } from 'vitest';
import { printDoctorReport, runDoctor } from '../../../src/cli/commands/doctor';
import type { GatewayConfig } from '../../../src/cli/lib/config-client';
import type { FetchLike } from '../../../src/cli/lib/http';
import { CommerceError } from '../../../src/core';
import {
  createCapturingIo,
  createFakeFetch,
  fetchFailed,
  jsonResponse,
  makeFakeReceiptStore,
  makeGatewayConfig,
} from './fixtures';

const GATEWAY = 'http://127.0.0.1:8080';
// Request deleted listings explicitly; the registry otherwise returns 404 for them
const LISTING_URL =
  'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.acme%2Fweather/versions/latest?include_deleted=true';
const REGISTRY = {
  name: 'io.github.acme/weather',
  version: '1.0.0',
  description: 'Weather forecasts, paid per call',
};

function config(
  options: { publicBaseUrl?: string; mcp?: GatewayConfig['protocols']['mcp'] } = {},
): GatewayConfig {
  const base = makeGatewayConfig();
  return makeGatewayConfig({
    merchant: {
      ...base.merchant,
      publicBaseUrl: options.publicBaseUrl ?? 'https://api.example.com',
    },
    protocols: {
      ...base.protocols,
      mcp: options.mcp ?? { enabled: true, mountPath: '/mcp', registry: REGISTRY },
    },
  });
}

// A registry response for an exported and published listing
function listing(
  server: Record<string, unknown> = {},
  official: Record<string, unknown> = { status: 'active' },
): Record<string, unknown> {
  return {
    server: {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      ...REGISTRY,
      remotes: [{ type: 'streamable-http', url: 'https://api.example.com/mcp' }],
      ...server,
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        publishedAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
        isLatest: true,
        ...official,
      },
    },
  };
}

// Record requests to a healthy gateway and backend. The optional `registry`
// handler answers the listing URL; without it, that request rejects as unreachable.
function fakeFetch(registry?: () => Response) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const inner = createFakeFetch({
    [`${GATEWAY}/health`]: () => jsonResponse({ status: 'ok' }),
    [`${GATEWAY}/ready`]: () => jsonResponse({ status: 'ready' }),
    [`${GATEWAY}/.well-known/agent-commerce`]: () => jsonResponse({ merchant: { id: 'm' } }),
    'http://localhost:3000/api/weather/demo-check': () => jsonResponse({}),
    ...(registry !== undefined ? { [LISTING_URL]: registry } : {}),
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return inner(input, init);
  }) as FetchLike;
  return { fetchImpl, requests };
}

async function doctor(options: {
  registry?: boolean;
  config?: GatewayConfig | Error;
  answer?: (() => Response) | undefined;
}) {
  const { fetchImpl, requests } = fakeFetch(options.answer);
  const loaded = options.config ?? config();
  const report = await runDoctor(
    {
      gatewayUrl: GATEWAY,
      ...(options.registry !== undefined ? { registry: options.registry } : {}),
    },
    {
      fetchImpl,
      loadConfig: async () => {
        if (loaded instanceof Error) throw loaded;
        return loaded;
      },
      createStore: () => makeFakeReceiptStore(),
      fillEnvFromManifest: (env) => ({ env, filled: [], manifestFound: false }),
      hasChainDeployScript: () => false,
    },
  );
  return {
    report,
    check: report.checks.find((c) => c.name === 'MCP Registry'),
    registryRequests: requests.filter((r) => r.url.startsWith('https://registry.')),
  };
}

describe('doctor --registry', () => {
  it('adds no check and sends nothing to the registry without the flag', async () => {
    const { check, registryRequests } = await doctor({ answer: () => jsonResponse(listing()) });
    expect(check).toBeUndefined();
    expect(registryRequests).toEqual([]);
  });

  it('asks for the configured name only, with no header or body', async () => {
    const { registryRequests } = await doctor({
      registry: true,
      answer: () => jsonResponse(listing()),
    });
    expect(registryRequests).toHaveLength(1);
    expect(registryRequests[0]?.url).toBe(LISTING_URL);
    expect(Object.keys(registryRequests[0]?.init ?? {})).toEqual(['signal']);
  });

  it.each([
    [
      'a listing that matches',
      () => jsonResponse(listing()),
      'PASS',
      'io.github.acme/weather 1.0.0 is listed as configured',
    ],
    [
      'another latest version',
      () => jsonResponse(listing({ version: '0.9.0' })),
      'WARN',
      'io.github.acme/weather: listing differs from config in version',
    ],
    [
      'another description and remote URL',
      () =>
        jsonResponse(
          listing({
            description: 'Old text',
            remotes: [{ type: 'streamable-http', url: 'https://old.example.com/mcp' }],
          }),
        ),
      'WARN',
      'io.github.acme/weather: listing differs from config in description, remotes',
    ],
    [
      'a second remote',
      () =>
        jsonResponse(
          listing({
            remotes: [
              { type: 'streamable-http', url: 'https://api.example.com/mcp' },
              { type: 'sse', url: 'https://api.example.com/sse' },
            ],
          }),
        ),
      'WARN',
      'io.github.acme/weather: listing differs from config in remotes',
    ],
    // The gateway URL under another server's name is not the merchant's listing
    [
      'a listing under another name',
      () => jsonResponse(listing({ name: 'io.github.other/weather' })),
      'WARN',
      'io.github.acme/weather: listing differs from config in name',
    ],
    [
      'a deprecated listing',
      () => jsonResponse(listing({}, { status: 'deprecated' })),
      'WARN',
      'io.github.acme/weather: listing is deprecated',
    ],
    [
      'a deleted listing',
      () => jsonResponse(listing({}, { status: 'deleted' })),
      'WARN',
      'io.github.acme/weather: listing is deleted',
    ],
    [
      'a listing with no status',
      () => jsonResponse({ server: listing()['server'] }),
      'WARN',
      'io.github.acme/weather: listing has no known status',
    ],
    [
      'a name it does not list',
      () => jsonResponse({ title: 'Not Found' }, 404),
      'WARN',
      'io.github.acme/weather is not listed',
    ],
    ['a server error', () => jsonResponse({}, 503), 'WARN', 'the registry answered HTTP 503'],
    [
      'an answer that is not a listing',
      () => jsonResponse(['io.github.acme/weather']),
      'WARN',
      'the registry answer is not a server listing',
    ],
  ])('reports %s', async (_label, answer, status, detail) => {
    const { check } = await doctor({ registry: true, answer });
    expect(check).toEqual({ name: 'MCP Registry', status, detail });
  });

  it('marks no answer as unreachable', async () => {
    const { check } = await doctor({ registry: true });
    expect(check).toEqual({
      name: 'MCP Registry',
      status: 'WARN',
      detail: 'no answer from the registry',
      undetermined: 'unreachable',
    });
  });

  it('leaves a TLS failure unmarked and does not print its message', async () => {
    const { report, check } = await doctor({
      registry: true,
      answer: () => {
        throw fetchFailed(
          'ERR_TLS_CERT_ALTNAME_INVALID',
          "Host is not in the cert's altnames: DNS:EVIL-CERT-NAME",
        );
      },
    });
    expect(check).toEqual({
      name: 'MCP Registry',
      status: 'WARN',
      detail: 'the registry request failed',
    });
    expect(JSON.stringify(report)).not.toContain('EVIL-CERT-NAME');
  });

  it('prints no value from a hostile answer, in text or JSON', async () => {
    const HOSTILE = '\u001b[31mHOSTILE\nPASS  Config';
    const { report } = await doctor({
      registry: true,
      answer: () =>
        jsonResponse({
          server: {
            name: HOSTILE,
            version: HOSTILE,
            description: HOSTILE,
            remotes: [{ type: HOSTILE, url: HOSTILE }],
            [HOSTILE]: HOSTILE,
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: HOSTILE } },
        }),
    });
    const text = createCapturingIo();
    printDoctorReport(report, text, false);
    const json = createCapturingIo();
    printDoctorReport(report, json, true);

    expect(report.checks.find((c) => c.name === 'MCP Registry')?.detail).toBe(
      'io.github.acme/weather: listing has no known status; listing differs from config in name, version, description, remotes',
    );
    for (const output of [text.out.join('\n'), json.out.join('\n')]) {
      expect(output).not.toContain('HOSTILE');
      expect(output).not.toContain('\u001b[31m');
    }
  });

  it.each([
    ['a listing that matches', () => jsonResponse(listing())],
    ['a deleted listing', () => jsonResponse(listing({}, { status: 'deleted' }))],
    ['no answer', undefined],
  ])('keeps the exit code of a run without the flag for %s', async (_label, answer) => {
    const without = await doctor({ answer });
    const withFlag = await doctor({ registry: true, answer });
    expect(withFlag.check?.status).not.toBe('FAIL');
    expect(withFlag.report.exitCode).toBe(without.report.exitCode);
  });

  it.each([
    [
      'config that does not load',
      new CommerceError('CONFIG_INVALID', 'bad config'),
      { status: 'WARN', detail: 'skipped: config invalid', undetermined: 'skipped' },
    ],
    [
      'no registry block',
      config({ mcp: { enabled: true, mountPath: '/mcp' } }),
      { status: 'INFO', detail: 'protocols.mcp.registry not configured' },
    ],
    [
      'an http public URL',
      config({ publicBaseUrl: 'http://api.example.com' }),
      {
        status: 'WARN',
        detail: 'merchant.publicBaseUrl must be an https:// URL: the MCP Registry refuses others',
      },
    ],
  ])('sends nothing for %s', async (_label, loaded, expected) => {
    const { check, registryRequests } = await doctor({
      registry: true,
      config: loaded,
      answer: () => jsonResponse(listing()),
    });
    expect(check).toEqual({ name: 'MCP Registry', ...expected });
    expect(registryRequests).toEqual([]);
  });
});
