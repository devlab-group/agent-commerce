import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { isCommerceError } from '../../../src/core/index.js';

const VALID_YAML = `
version: 1
merchant:
  id: demo-store
  name: Demo Data Store
  publicBaseUrl: http://localhost:8080
server:
  port: 8080
  host: 0.0.0.0
storage:
  receipts:
    driver: sqlite
    path: ./data/receipts.sqlite
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources:
  weather_basic:
    name: Basic Weather
    input:
      type: object
      properties:
        city:
          type: string
      required: [city]
      additionalProperties: false
    backend:
      type: http
      method: GET
      url: http://localhost:3000/api/weather/{city}
    pricing:
      type: free
    expose: [http, mcp]
payments: {}
`;

const DUPLICATE_KEY_YAML = `
version: 1
merchant:
  id: demo-store
  name: Demo Data Store
  publicBaseUrl: http://localhost:8080
server:
  port: 8080
  host: 0.0.0.0
storage:
  receipts:
    driver: sqlite
    path: ./data/receipts.sqlite
protocols:
  http:
    enabled: true
  mcp:
    enabled: true
    mountPath: /mcp
resources:
  weather_basic:
    name: First
    backend: { type: http, method: GET, url: http://localhost:3000/a }
    pricing: { type: free }
    expose: [http]
  weather_basic:
    name: Second
    backend: { type: http, method: GET, url: http://localhost:3000/b }
    pricing: { type: free }
    expose: [http]
payments: {}
`;

let tmpDir: string | undefined;

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oac-config-test-'));
  tmpDir = dir;
  return dir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('loadConfig', () => {
  it('loads and parses a valid config from an explicit path', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'my-config.yaml');
    await fs.writeFile(file, VALID_YAML, 'utf8');

    const config = await loadConfig({ path: file, env: {} });
    expect(config.merchant.id).toBe('demo-store');
    expect(config.resources).toHaveLength(1);
  });

  it('locates the config via AGENT_COMMERCE_CONFIG when no explicit path is given', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'via-env.yaml');
    await fs.writeFile(file, VALID_YAML, 'utf8');

    const config = await loadConfig({ env: { AGENT_COMMERCE_CONFIG: file } });
    expect(config.merchant.id).toBe('demo-store');
  });

  it('defaults to./config.yaml under cwd', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'config.yaml'), VALID_YAML, 'utf8');

    const config = await loadConfig({ cwd: dir, env: {} });
    expect(config.merchant.id).toBe('demo-store');
  });

  it('throws CONFIG_INVALID with an actionable message when the file is missing', async () => {
    const dir = await makeTmpDir();
    try {
      await loadConfig({ path: path.join(dir, 'does-not-exist.yaml'), env: {} });
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (isCommerceError(error)) {
        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.message).toContain('does-not-exist.yaml');
      }
    }
  });

  it('throws CONFIG_INVALID on invalid YAML syntax', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'broken.yaml');
    await fs.writeFile(file, 'version: 1\n  bad indent: [\n', 'utf8');

    try {
      await loadConfig({ path: file, env: {} });
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (isCommerceError(error)) expect(error.code).toBe('CONFIG_INVALID');
    }
  });

  it('throws CONFIG_INVALID on a duplicate resource id (duplicate YAML key)', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'dup.yaml');
    await fs.writeFile(file, DUPLICATE_KEY_YAML, 'utf8');

    try {
      await loadConfig({ path: file, env: {} });
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (isCommerceError(error)) {
        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.message.toLowerCase()).toContain('unique');
      }
    }
  });

  it('propagates env-substitution failures through loadConfig', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'unresolved.yaml');
    await fs.writeFile(
      file,
      VALID_YAML.replace('http://localhost:8080', '${GATEWAY_PUBLIC_BASE_URL}'),
      'utf8',
    );

    try {
      await loadConfig({ path: file, env: {} });
      expect.unreachable();
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.message).toContain('GATEWAY_PUBLIC_BASE_URL');
      }
    }
  });

  it.each([
    [
      'a syntax error next to an inline adminToken',
      'server:\n  adminToken: super-secret-token-value: oops\n  port: 8080\n',
      'super-secret-token-value',
    ],
    [
      'a duplicate key next to an inline signerPrivateKey',
      'version: 1\nx:\n  signerPrivateKey: 0xdeadbeefsecretkeymaterial\n  signerPrivateKey: 0xdeadbeefsecretkeymaterial\n',
      '0xdeadbeefsecretkeymaterial',
    ],
  ])('%s does not reproduce the source line into the error', async (_label, yaml, secret) => {
    // The `yaml` package builds its `message` with a code-frame excerpt of
    // the offending source line. Interpolating it put inline secrets into
    // `validate`/`doctor` output — `doctor --json` above all, which is what
    // gets pasted into bug reports. The error is now built from `code` and
    // `linePos`, which locate the fault just as precisely and cannot carry
    // file content. Assert the position survives, so this cannot be
    // "fixed" by degrading the diagnostic into uselessness.
    const dir = await makeTmpDir();
    const file = path.join(dir, 'bad.yaml');
    await fs.writeFile(file, yaml, 'utf8');

    try {
      await loadConfig({ path: file, env: {} });
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (!isCommerceError(error)) return;
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error.details)).not.toContain(secret);
      // Still actionable: a code and a position.
      expect(error.details?.['yamlErrorCode']).toBeDefined();
      expect(error.details?.['line']).toBeDefined();
    }
  });
});
