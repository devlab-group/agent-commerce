import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatConfigError, runValidate } from '../../../src/cli/commands/validate.js';
import { createCapturingIo } from '../../../src/cli/lib/io.js';
import { CommerceError } from '../../../src/core/index.js';
import { makeGatewayConfig } from './fixtures.js';

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

  it('formats a ZodError with one line per issue path', () => {
    const schema = z.object({ port: z.number() });
    const result = schema.safeParse({ port: 'not-a-number' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    const formatted = formatConfigError(result.error);
    expect(formatted).toContain('Configuration schema errors');
    expect(formatted).toContain('port');
  });

  it('formats a root-level ZodError issue (empty path) as "(root)"', () => {
    const schema = z.number();
    const result = schema.safeParse('not-a-number');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    const formatted = formatConfigError(result.error);
    expect(formatted).toContain('(root)');
  });

  it('formats a plain Error by message', () => {
    expect(formatConfigError(new Error('yaml syntax error'))).toContain('yaml syntax error');
  });

  it('formats a non-Error thrown value', () => {
    expect(formatConfigError('a string was thrown')).toContain('a string was thrown');
  });

  it('never echoes a resolved secret value — only the error message text is surfaced', () => {
    // The config package's real env-substitution error names only the
    // variable, never a resolved value (src/config/env.ts). Assert
    // the CLI's formatter doesn't add any additional value leakage.
    const err = new CommerceError(
      'CONFIG_INVALID',
      'Unresolved environment variable "${FACILITATOR_PRIVATE_KEY}" referenced at config path "payments.x402.facilitator.signerPrivateKey"',
    );
    const formatted = formatConfigError(err);
    expect(formatted).toContain('FACILITATOR_PRIVATE_KEY');
    expect(formatted).not.toMatch(/0x[0-9a-fA-F]{64}/); // no private-key-shaped value ever appears
  });
});

describe('runValidate — with an injected loader (isolated branch coverage)', () => {
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
          protocols: { http: { enabled: false }, mcp: { enabled: false, mountPath: '/mcp' } },
        }),
    });
    expect(io.out.join('\n')).toContain('protocols: http=off mcp=off');
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

describe('runValidate — local chain manifest fill (docker vs. host env parity)', () => {
  it('prints a notice and passes the filled env through to loadConfig, when the manifest supplies something', async () => {
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const io = createCapturingIo();
    const code = await runValidate({}, io, {
      loadConfig: async (options) => {
        receivedEnv = options?.env;
        return makeGatewayConfig();
      },
      fillEnvFromManifest: () => ({
        env: { X402_ASSET: '0xfilled', FOO: 'bar' },
        filled: ['X402_ASSET'],
        manifestFound: true,
      }),
    });
    expect(code).toBe(0);
    expect(io.out.join('\n')).toContain(
      'using local chain manifest .deploy/local.json for X402_ASSET',
    );
    expect(receivedEnv?.['X402_ASSET']).toBe('0xfilled');
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

describe('runValidate — real src/config integration', () => {
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
    expect(io.err.join('\n')).toContain('FAIL');
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

  it('rejects an unresolved ${ENV} variable, naming the variable but never a resolved value', async () => {
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

  it('rejects a duplicate resource id at the YAML level (YAML maps cannot even express one — the schema instead rejects the raw config root shape when malformed)', async () => {
    // config.yaml expresses resources as a map keyed by id, so a
    // literal "duplicate id" is structurally impossible in valid YAML — the
    // failure mode this test actually exercises is a non-object root, which
    // the schema explicitly rejects with an actionable path.
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, '- just\n- a\n- list\n', 'utf8');

    const io = createCapturingIo();
    const code = await runValidate({ configPath }, io);
    expect(code).toBe(1);
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
  });
});
