import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatConfigError, runValidate } from '../../../src/cli/commands/validate';
import { CommerceError } from '../../../src/core';
import { createCapturingIo, makeGatewayConfig } from './fixtures';

describe('formatConfigError', () => {
  it('formats a CommerceError with its code, message and details', () => {
    const err = new CommerceError('CONFIG_INVALID', 'bad thing', {
      details: { path: 'server.port' },
    });
    const formatted = formatConfigError(err);
    expect(formatted).toContain('CONFIG_INVALID');
    expect(formatted).toContain('bad thing');
    expect(formatted).toContain('server.port');
  });

  it('formats a plain Error by message', () => {
    expect(formatConfigError(new Error('yaml syntax error'))).toContain('yaml syntax error');
  });

  it('formats a non-Error thrown value', () => {
    expect(formatConfigError('a string was thrown')).toContain('a string was thrown');
  });
});

describe('runValidate with an injected loader (isolated branch coverage)', () => {
  it('PASS: prints a summary and returns exit code 0 for a valid config', async () => {
    const io = createCapturingIo();
    const code = await runValidate({}, io, { loadConfig: async () => makeGatewayConfig() });
    expect(code).toBe(0);
    expect(io.out.join('\n')).toContain('PASS  Configuration is valid');
    expect(io.out.join('\n')).toContain('resources: 1');
  });

  it('FAIL: prints the formatted error and returns exit code 1', async () => {
    const io = createCapturingIo();
    const code = await runValidate({}, io, {
      loadConfig: async () => {
        throw new CommerceError('CONFIG_INVALID', 'missing field "merchant"');
      },
    });
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('CONFIG_INVALID');
  });

  it('shows http/mcp as "off" when disabled in config', async () => {
    const io = createCapturingIo();
    await runValidate({}, io, {
      loadConfig: async () =>
        makeGatewayConfig({
          protocols: {
            http: { enabled: false },
            mcp: { enabled: false, mountPath: '/mcp' },
            a2a: { enabled: false, mountPath: '/a2a' },
            acp: { enabled: false, mountPath: '/acp' },
          },
        }),
    });
    expect(io.out.join('\n')).toContain('protocols: http=off mcp=off');
  });

  it('reports every payment rail and authorization method, not only x402', async () => {
    const io = createCapturingIo();
    await runValidate({}, io, { loadConfig: async () => makeGatewayConfig() });
    expect(io.out.join('\n')).toContain('payments: x402=off mpp=off');
    expect(io.out.join('\n')).toContain('authorization: ap2=off');
  });

  it('passes the --config path through to the loader', async () => {
    let receivedPath: string | undefined;
    const io = createCapturingIo();
    await runValidate({ configPath: '/some/path.yaml' }, io, {
      loadConfig: async (options) => {
        receivedPath = options?.path;
        return makeGatewayConfig();
      },
    });
    expect(receivedPath).toBe('/some/path.yaml');
  });
});

describe('runValidate: local chain manifest fill (docker vs. host env parity)', () => {
  it('prints a notice naming the filled variables, not their values, and passes the filled env to loadConfig', async () => {
    const key = `0x${'ab'.repeat(32)}`;
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const io = createCapturingIo();
    const code = await runValidate({}, io, {
      loadConfig: async (options) => {
        receivedEnv = options?.env;
        return makeGatewayConfig();
      },
      fillEnvFromManifest: () => ({
        env: { X402_ASSET: '0xfilled', X402_FACILITATOR_PRIVATE_KEY: key, FOO: 'bar' },
        filled: ['X402_ASSET', 'X402_FACILITATOR_PRIVATE_KEY'],
        manifestFound: true,
      }),
    });
    expect(code).toBe(0);
    expect(io.out.join('\n')).toContain(
      'using local chain manifest .deploy/local.json for X402_ASSET, X402_FACILITATOR_PRIVATE_KEY',
    );
    expect(io.out.join('\n')).not.toContain(key);
    expect(receivedEnv?.['X402_FACILITATOR_PRIVATE_KEY']).toBe(key);
  });

  it('prints nothing when nothing needed filling (manifest absent, or everything already set)', async () => {
    const io = createCapturingIo();
    await runValidate({}, io, {
      loadConfig: async () => makeGatewayConfig(),
      fillEnvFromManifest: () => ({ env: process.env, filled: [], manifestFound: false }),
    });
    expect(io.out.join('\n')).not.toContain('using local chain manifest');
  });

  it('adds a "run npm run chain:deploy" hint when the failure is an unresolved manifest-fillable variable and no manifest was found', async () => {
    const io = createCapturingIo();
    const code = await runValidate({}, io, {
      loadConfig: async () => {
        throw new CommerceError(
          'CONFIG_INVALID',
          'Unresolved environment variable "${X402_ASSET}" referenced at config path "$.payments.x402.asset"',
          { details: { variable: 'X402_ASSET', path: '$.payments.x402.asset' } },
        );
      },
      fillEnvFromManifest: () => ({ env: process.env, filled: [], manifestFound: false }),
    });
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('npm run chain:deploy');
  });

  it('does NOT add the hint when a manifest was found (the failure is something else)', async () => {
    const io = createCapturingIo();
    await runValidate({}, io, {
      loadConfig: async () => {
        throw new CommerceError(
          'CONFIG_INVALID',
          'Unresolved environment variable "${X402_ASSET}" referenced at config path "$.payments.x402.asset"',
          { details: { variable: 'X402_ASSET', path: '$.payments.x402.asset' } },
        );
      },
      fillEnvFromManifest: () => ({ env: process.env, filled: [], manifestFound: true }),
    });
    expect(io.err.join('\n')).not.toContain('npm run chain:deploy');
  });

  it('does NOT add the hint when the unresolved variable is unrelated to the manifest', async () => {
    const io = createCapturingIo();
    await runValidate({}, io, {
      loadConfig: async () => {
        throw new CommerceError(
          'CONFIG_INVALID',
          'Unresolved environment variable "${DASHBOARD_ORIGIN}" referenced at config path "$.server.allowedOrigins[0]"',
          { details: { variable: 'DASHBOARD_ORIGIN', path: '$.server.allowedOrigins[0]' } },
        );
      },
      fillEnvFromManifest: () => ({ env: process.env, filled: [], manifestFound: false }),
    });
    expect(io.err.join('\n')).not.toContain('npm run chain:deploy');
  });
});

describe('runValidate against the real src/config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-commerce-validate-'));
  });

  it('accepts a well-formed config.yaml (exit code 0)', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      `
version: 1
merchant:
  id: demo-merchant
  name: Demo Merchant
  publicBaseUrl: http://localhost:8080
server:
  port: 8080
  host: 0.0.0.0
storage:
  receipts:
    driver: sqlite
    path: ./data/receipts.db
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources:
  weather:
    name: Get weather
    input:
      type: object
      properties:
        city:
          type: string
      required: [city]
    backend:
      type: http
      method: GET
      url: http://localhost:3000/api/weather/{city}
    pricing:
      type: free
    expose: [http, mcp]
payments: {}
`,
      'utf8',
    );

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io);
    expect(code).toBe(0);
    expect(io.out.join('\n')).toContain('PASS');
  });

  it('rejects invalid YAML syntax (exit code 1)', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, 'version: 1\nmerchant: [unclosed', 'utf8');

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io);
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('is not valid YAML');
  });

  it('rejects a schema violation with the failing path named', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      `
version: 1
merchant:
  id: demo-merchant
  name: Demo Merchant
  publicBaseUrl: http://localhost:8080
server:
  port: not-an-integer
  host: 0.0.0.0
storage:
  receipts:
    driver: sqlite
    path: ./data/receipts.db
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources: {}
payments: {}
`,
      'utf8',
    );

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io);
    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/server\.port/);
  });

  it('rejects an unresolved ${ENV} variable, naming the variable', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      `
version: 1
merchant:
  id: demo-merchant
  name: Demo Merchant
  publicBaseUrl: \${DOES_NOT_EXIST_ENV_VAR}
server:
  port: 8080
  host: 0.0.0.0
storage:
  receipts:
    driver: sqlite
    path: ./data/receipts.db
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources: {}
payments: {}
`,
      'utf8',
    );

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io, {});
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('DOES_NOT_EXIST_ENV_VAR');
  });

  it('rejects a config whose root is not a map', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, '- just\n- a\n- list\n', 'utf8');

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io);
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('root must be a mapping');
  });

  it('rejects an unsupported protocol on a resource', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      `
version: 1
merchant:
  id: demo-merchant
  name: Demo Merchant
  publicBaseUrl: http://localhost:8080
server:
  port: 8080
  host: 0.0.0.0
storage:
  receipts:
    driver: sqlite
    path: ./data/receipts.db
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources:
  weather:
    name: Get weather
    backend:
      type: http
      method: GET
      url: http://localhost:3000/api/weather
    pricing:
      type: free
    expose: [ucp]
payments: {}
`,
      'utf8',
    );

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io);
    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/ucp/i);
  });

  it('rejects an invalid payment combination (fixed pricing with no payment method named)', async () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      `
version: 1
merchant:
  id: demo-merchant
  name: Demo Merchant
  publicBaseUrl: http://localhost:8080
server:
  port: 8080
  host: 0.0.0.0
storage:
  receipts:
    driver: sqlite
    path: ./data/receipts.db
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources:
  report:
    name: Get report
    backend:
      type: http
      method: GET
      url: http://localhost:3000/api/report
    pricing:
      type: fixed
      amount: "0.01"
      currency: USDC
    expose: [http]
payments: {}
`,
      'utf8',
    );

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io);
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('has fixed pricing but declares no "payments"');
  });

  describe('credentials resolved from the environment', () => {
    const SECRETS = {
      ADMIN_TOKEN: 'ADMIN-TOKEN-0123456789abcdef',
      RPC_KEY: 'RPC-KEY-SECRET',
      FACILITATOR_TOKEN: 'FACILITATOR-TOKEN-SECRET',
      MPP_CHALLENGE_SECRET: 'MPP-CHALLENGE-SECRET-0123456789abcdef',
    };
    const rail = `
    network: eip155:84532
    rpcUrl: "https://rpc.example/v2/\${RPC_KEY}"
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    assetName: USDC
    assetVersion: "2"
    facilitator:
      mode: remote
      url: https://facilitator.example
      auth: { type: bearer, token: "\${FACILITATOR_TOKEN}" }`;
    const configWith = (port: string) => `
version: 1
merchant: { id: demo, name: Demo, publicBaseUrl: http://localhost:8080 }
server: { port: ${port}, host: 127.0.0.1, adminToken: "\${ADMIN_TOKEN}" }
storage: { receipts: { driver: sqlite, path: ./data/receipts.db } }
protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: /mcp } }
resources:
  report:
    name: Report
    backend: { type: http, method: GET, url: "http://localhost:3000/api/report" }
    pricing: { type: fixed, amount: "0.01", currency: USDC }
    expose: [http]
    payments: [x402, mpp]
payments:
  x402:
    enabled: true
    assetDecimals: 6
    payTo: "0x1111111111111111111111111111111111111111"
    maxTimeoutSeconds: 60${rail}
  mpp:
    enabled: true
    recipient: "0x1111111111111111111111111111111111111111"
    realm: api.example.com
    challengeSecret: "\${MPP_CHALLENGE_SECRET}"${rail}
`;

    async function validate(port: string) {
      const configPath = join(dir, 'config.yaml');
      writeFileSync(configPath, configWith(port), 'utf8');
      const io = createCapturingIo();
      const code = await runValidate({ configPath }, io, {
        fillEnvFromManifest: () => ({ env: SECRETS, filled: [], manifestFound: false }),
      });
      return { code, printed: [...io.out, ...io.err].join('\n') };
    }

    it('are never printed when the config is valid', async () => {
      const { code, printed } = await validate('8080');
      expect(code).toBe(0);
      expect(printed).toContain('payments: x402=on mpp=on');
      for (const secret of Object.values(SECRETS)) {
        expect(printed).not.toContain(secret);
      }
    });

    it('are never printed when another field is invalid', async () => {
      const { code, printed } = await validate('not-a-port');
      expect(code).toBe(1);
      expect(printed).toContain('server.port');
      for (const secret of Object.values(SECRETS)) {
        expect(printed).not.toContain(secret);
      }
    });
  });
});
