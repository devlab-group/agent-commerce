// `main.ts` is the composition root that `npm run demo:gateway` and the Docker
// Compose gateway service run. E2E and integration tests build the gateway
// with `createGateway`, so only these tests run the entry point: each starts
// it as a child process against a config file in its own temporary directory.
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RPC_KEY = 'RPC-KEY-IN-PATH';
// Nothing listens on port 1, so no provider reaches a chain
const RPC_URL = `http://127.0.0.1:1/v2/${RPC_KEY}`;
const X402_SIGNER = `0x${'22'.repeat(32)}`;
const MPP_SIGNER = `0x${'44'.repeat(32)}`;
const MERCHANT_WALLET = '0x3333333333333333333333333333333333333333';
// Root ignores file modes, so an unwritable store cannot be staged
const RUNS_AS_ROOT = process.getuid?.() === 0;

// The RFC 7515 appendix A.3.1 public key: a real P-256 point with no private half to keep
const PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

type Section = Record<string, unknown>;

interface RawConfig {
  [key: string]: unknown;
  protocols: Section;
  resources: Record<string, Section>;
  payments: Section;
}

function baseConfig(dir: string): RawConfig {
  return {
    version: 1,
    merchant: { id: 'main-smoke', name: 'Main Smoke', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1' },
    storage: { receipts: { driver: 'sqlite', path: join(dir, 'receipts.sqlite') } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
    },
    resources: {
      market_report: {
        name: 'Premium Market Report',
        input: { type: 'object', properties: {}, additionalProperties: false },
        backend: { type: 'http', method: 'GET', url: 'http://localhost:3000/api/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        expose: ['http', 'mcp'],
        payments: ['x402'],
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: 'eip155:84532',
        rpcUrl: RPC_URL,
        asset: '0x1111111111111111111111111111111111111111',
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: MERCHANT_WALLET,
        maxTimeoutSeconds: 120,
        facilitator: { mode: 'local', signerPrivateKey: X402_SIGNER },
      },
    },
  };
}

function ap2Block(dir: string) {
  const issuer = (name: string, audience: string, kid: string) => ({
    issuer: name,
    audience,
    keys: [{ kid, jwk: PUBLIC_JWK }],
  });
  return {
    ap2: {
      enabled: true,
      replay: { path: join(dir, 'ap2.sqlite') },
      trust: {
        mandateIssuers: [issuer('https://trusted-surface.example', 'merchant.example', 'm-1')],
        checkoutIssuers: [issuer('https://merchant.example', 'agent-commerce', 'c-1')],
      },
    },
  };
}

// A free resource shaped like the envelope the ACP adapter sends
// What the adapter sends: `path` carries the session id, `body` the ACP document
const ACP_ENVELOPE_SCHEMAS: Record<string, object> = {
  path: { type: 'object', properties: { checkout_session_id: { type: 'string' } } },
  body: { type: 'object', additionalProperties: true },
};

function acpResource(keys: readonly string[], optional: readonly string[] = []) {
  const declared = [...keys, ...optional];
  return {
    name: 'ACP checkout operation',
    input: {
      type: 'object',
      properties: Object.fromEntries(declared.map((key) => [key, ACP_ENVELOPE_SCHEMAS[key]])),
      required: [...keys],
      additionalProperties: false,
    },
    backend: {
      type: 'http',
      method: 'POST',
      url: 'http://localhost:3000/checkout',
      inputBindings: Object.fromEntries(declared.map((key) => [key, key])),
    },
    pricing: { type: 'free' },
    expose: ['acp'],
  };
}

// Every protocol, both rails and AP2, with each store in `dir`
function fullConfig(dir: string) {
  const config = baseConfig(dir);
  config.protocols['a2a'] = { enabled: true, mountPath: '/a2a' };
  config.protocols['acp'] = {
    enabled: true,
    auth: { type: 'bearer', token: 'acp-token' },
    idempotency: { path: join(dir, 'acp.sqlite') },
    checkout: {
      operations: {
        createCheckoutSession: 'acp_create',
        updateCheckoutSession: 'acp_update',
        getCheckoutSession: 'acp_get',
        completeCheckoutSession: 'acp_complete',
        cancelCheckoutSession: 'acp_cancel',
      },
    },
  };
  Object.assign(config.resources, {
    acp_create: acpResource(['body']),
    acp_update: acpResource(['path', 'body']),
    acp_get: acpResource(['path']),
    acp_complete: acpResource(['path', 'body']),
    acp_cancel: acpResource(['path'], ['body']),
  });
  const report = config.resources['market_report'] as Section;
  report['payments'] = ['x402', 'mpp'];
  report['authorization'] = { required: ['ap2'] };
  config.payments['mpp'] = {
    enabled: true,
    rpcUrl: RPC_URL,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    assetName: 'USDC',
    assetVersion: '2',
    recipient: MERCHANT_WALLET,
    realm: 'shop.example',
    challengeSecret: 'mpp-challenge-secret-'.padEnd(32, 'x'),
    facilitator: { mode: 'local', signerPrivateKey: MPP_SIGNER },
  };
  config['authorization'] = ap2Block(dir);
  return config;
}

// Starts main.ts on `config` (JSON is valid YAML) and collects what it prints
function startMain(dir: string, config: unknown, env: Record<string, string> = {}) {
  const path = join(dir, 'config.yaml');
  writeFileSync(path, JSON.stringify(config));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/gateway/main.ts'], {
    // JSON log lines, one of which carries the bound URL
    env: {
      ...process.env,
      AGENT_COMMERCE_CONFIG: path,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));

  // Resolves once stdout holds every piece; pino and console.log write separately
  const printed = (...pieces: string[]) =>
    Promise.race([
      new Promise<void>((resolve) => {
        const check = () => {
          if (pieces.every((piece) => output.stdout.includes(piece))) resolve();
        };
        child.stdout.on('data', check);
        check();
      }),
      exited.then((code) => {
        throw new Error(`gateway exited with ${code}: ${output.stderr}`);
      }),
    ]);

  const url = () =>
    output.stdout
      .split('\n')
      .filter((line) => line.startsWith('{') && line.endsWith('}'))
      .map((line) => JSON.parse(line) as { msg?: string; url?: string })
      .find((line) => line.msg === 'gateway listening')?.url ?? '';

  const stop = () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  return { child, output, exited, printed, url, stop };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'oac-main-'));
}

describe.concurrent('gateway entry point (main.ts)', () => {
  it('boots x402 and MCP, prints the settlement origin without the RPC path, and exits 0 on SIGTERM', async () => {
    const dir = tempDir();
    const gateway = startMain(dir, baseConfig(dir));
    try {
      await gateway.printed('"gateway listening"', 'facilitator  local');
      expect(gateway.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const health = await fetch(`${gateway.url()}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      // A provider may put its API key in the RPC path, so only the origin is printed
      expect(gateway.output.stdout).toContain('via http://127.0.0.1:1');
      expect(gateway.output.stdout).toContain(`pays to      ${MERCHANT_WALLET}`);
      expect(gateway.output.stdout).not.toContain(RPC_KEY);
      expect(gateway.output.stdout + gateway.output.stderr).not.toContain(X402_SIGNER.slice(2));

      gateway.child.kill('SIGTERM');
      expect(await gateway.exited).toBe(0);
    } finally {
      gateway.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('wires every protocol, both rails and AP2, reports each in /ready, and exits 0 on SIGINT', async () => {
    const dir = tempDir();
    const gateway = startMain(dir, fullConfig(dir));
    try {
      await gateway.printed('"gateway listening"', 'MPP settlement', 'facilitator  local\n\n');

      const ready = (await (await fetch(`${gateway.url()}/ready`)).json()) as Record<
        string,
        { name: string }[]
      >;
      const names = (key: string) => (ready[key] ?? []).map((check) => check.name).sort();
      expect(names('adapters')).toEqual(['a2a', 'acp', 'mcp']);
      expect(names('paymentProviders')).toEqual(['mpp', 'x402']);
      expect(names('authorizationProviders')).toEqual(['ap2']);

      // The Agent Card names the merchant, not the software
      const card = await fetch(`${gateway.url()}/.well-known/agent-card.json`);
      expect(card.status).toBe(200);
      expect(((await card.json()) as { name?: string }).name).toBe('Main Smoke');
      expect((await fetch(`${gateway.url()}/.well-known/acp.json`)).status).toBe(200);

      const mppBlock = gateway.output.stdout.slice(gateway.output.stdout.indexOf('MPP settlement'));
      expect(mppBlock).toContain('via http://127.0.0.1:1');
      expect(mppBlock).toContain(`pays to      ${MERCHANT_WALLET}`);
      expect(gateway.output.stdout).not.toContain(RPC_KEY);
      for (const signer of [X402_SIGNER, MPP_SIGNER]) {
        expect(gateway.output.stdout + gateway.output.stderr).not.toContain(signer.slice(2));
      }

      gateway.child.kill('SIGINT');
      expect(await gateway.exited).toBe(0);
    } finally {
      gateway.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('exits 1 on an invalid config before listening, without printing a substituted secret', async () => {
    const dir = tempDir();
    const config = baseConfig(dir);
    const report = config.resources['market_report'] as Section;
    report['backend'] = {
      type: 'http',
      method: 'GET',
      url: 'backend.internal/v1?key=${BACKEND_KEY}',
    };
    const gateway = startMain(dir, config, { BACKEND_KEY: 'BACKEND-KEY-IN-URL' });
    try {
      expect(await gateway.exited).toBe(1);
      expect(gateway.output.stderr).toContain('CONFIG_INVALID');
      expect(gateway.output.stderr).toContain('resources.market_report.backend.url');
      expect(gateway.output.stdout + gateway.output.stderr).not.toContain('BACKEND-KEY-IN-URL');
      expect(gateway.output.stdout).not.toContain('gateway listening');
    } finally {
      gateway.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  describe.skipIf(RUNS_AS_ROOT)('a store that cannot be written', () => {
    it.each([
      ['the receipt store', (dir: string) => baseConfig(dir), 'receipts.sqlite'],
      [
        'the AP2 replay store',
        (dir: string) => ({ ...baseConfig(dir), authorization: ap2Block(dir) }),
        'ap2.sqlite',
      ],
    ])(
      'stops startup when %s is read-only',
      async (_label, config, file) => {
        const dir = tempDir();
        writeFileSync(join(dir, file), '');
        chmodSync(join(dir, file), 0o400);
        const gateway = startMain(dir, config(dir));
        try {
          expect(await gateway.exited).toBe(1);
          expect(gateway.output.stderr).toContain('STORAGE_ERROR');
          expect(gateway.output.stderr).toContain(`${file}" exists but is not writable`);
          expect(gateway.output.stdout).not.toContain('gateway listening');
        } finally {
          gateway.stop();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000,
    );
  });
});
