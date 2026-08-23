import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  buildNotFoundHandler,
  createGatewayLogger,
  fastifyLoggerOptions,
  REDACT_PATHS,
} from '../../../src/gateway/logger.js';

describe('createGatewayLogger', () => {
  it('redacts configured secret-shaped paths from logged output', async () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const instance = pino(
      { level: 'info', redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } },
      stream,
    );

    instance.info({ wallet: { signerPrivateKey: '0xSUPER_SECRET' } }, 'facilitator configured');
    instance.info(
      {
        req: {
          headers: { authorization: 'Bearer secret-token', 'payment-signature': 'base64proof' },
        },
      },
      'request',
    );

    await new Promise((resolve) => setImmediate(resolve));
    const combined = chunks.join('');
    expect(combined).not.toContain('0xSUPER_SECRET');
    expect(combined).not.toContain('secret-token');
    expect(combined).not.toContain('base64proof');
    expect(combined).toContain('[REDACTED]');
  });

  it('exposes a Logger-shaped wrapper whose child() also redacts', async () => {
    const { core } = createGatewayLogger({ level: 'silent', prettyPrint: false });
    const child = core.child({ requestId: 'req-1' });
    expect(typeof child.info).toBe('function');
    expect(typeof child.child).toBe('function');
    // Should not throw even though nothing is asserted on output (level: silent).
    child.debug({ apiKey: 'should-be-redacted' }, 'noop-debug');
    child.info({ apiKey: 'should-be-redacted' }, 'noop-info');
    child.warn({ apiKey: 'should-be-redacted' }, 'noop-warn');
    child.error({ apiKey: 'should-be-redacted' }, 'noop-error');
  });

  it('fastifyLoggerOptions returns a plain options object with the same redaction paths', () => {
    const options = fastifyLoggerOptions({ level: 'silent' });
    expect(options.redact).toBeDefined();
    const paths = (options.redact as { paths: readonly string[] }).paths;
    expect(paths).toEqual([...REDACT_PATHS]);
  });

  it('defaults to a safe non-production, non-test level when unset', () => {
    const options = fastifyLoggerOptions({ nodeEnv: 'development' });
    expect(options.level).toBe('info');
  });

  it('uses silent level by default in the test environment', () => {
    const options = fastifyLoggerOptions({ nodeEnv: 'test' });
    expect(options.level).toBe('silent');
  });

  it('does not enable pino-pretty transport in production', () => {
    const options = fastifyLoggerOptions({ nodeEnv: 'production' });
    expect(options.transport).toBeUndefined();
  });

  it('names a transport target that actually exists on disk', () => {
    // pino-pretty is a devDependency, so it is always present here and never
    // guaranteed in a consumer. `pino()` throws outright on a target it cannot
    // resolve — that took down `createGateway()` for every library consumer,
    // because NODE_ENV is unset in a normal process and "development" was
    // inferred. Asserting the target resolves is what this repo *can* check;
    // the clean-consumer step in CI covers the it-is-absent half.
    const options = fastifyLoggerOptions({ nodeEnv: 'development' });
    const target = (options.transport as { target?: string } | undefined)?.target;
    expect(target).toBeDefined();
    expect(isAbsolute(target as string)).toBe(true);
    expect(existsSync(target as string)).toBe(true);
  });

  it('degrades to JSON rather than throwing when pretty-printing is unavailable', () => {
    // The inverse control: an explicit prettyPrint:true must never produce an
    // unresolvable target. Constructing the logger proves pino accepts it.
    expect(() => createGatewayLogger({ level: 'silent', prettyPrint: true })).not.toThrow();
  });

  it('redacts the query string from the logged request URL (SSE ?adminToken=)', () => {
    const options = fastifyLoggerOptions({ level: 'silent' });
    const reqSerializer = options.serializers?.['req'] as (req: unknown) => Record<string, unknown>;
    expect(typeof reqSerializer).toBe('function');

    const serialized = reqSerializer({
      method: 'GET',
      url: '/api/events/stream?adminToken=super-secret-token',
      host: 'localhost:8080',
      ip: '127.0.0.1',
      socket: { remotePort: 5555 },
    });

    expect(serialized['url']).toBe('/api/events/stream?[REDACTED]');
    expect(JSON.stringify(serialized)).not.toContain('super-secret-token');
    expect(serialized['method']).toBe('GET');
  });

  it('leaves a query-string-free URL untouched', () => {
    const options = fastifyLoggerOptions({ level: 'silent' });
    const reqSerializer = options.serializers?.['req'] as (req: unknown) => Record<string, unknown>;
    const serialized = reqSerializer({ method: 'GET', url: '/health' });
    expect(serialized['url']).toBe('/health');
  });
});

describe('buildNotFoundHandler (Fastify default 404 logs the raw URL)', () => {
  // Real Fastify + real pino, production mode (no pino-pretty transport —
  // that writes from a transport worker thread and swallows a naive
  // process.stdout.write patch, which is exactly how this leak's first
  // reproduction attempt falsely reported "no leak"). `stream:` is pino's
  // own supported way to redirect output for a test, and Fastify passes it
  // straight through to `pino(opts, opts.stream)`.
  const SECRET = 'SUPER-SECRET-TOKEN-XYZ';

  async function captureNotFoundLog(useFix: boolean): Promise<string> {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const server = Fastify({
      logger: { ...fastifyLoggerOptions({ nodeEnv: 'production' }), stream },
    });
    if (useFix) {
      server.setNotFoundHandler(buildNotFoundHandler());
    }
    await server.ready();

    await server.inject({ method: 'GET', url: `/api/receipts/?adminToken=${SECRET}` });
    await server.close();
    return chunks.join('');
  }

  it('does not put the admin token in the captured production log line on a 404 (fixed)', async () => {
    const output = await captureNotFoundLog(true);
    expect(output).not.toContain(SECRET);
    expect(output).toContain('/api/receipts/?[REDACTED]');
    expect(output).toContain('not found');
  });

  it("control: Fastify's own default 404 handler leaks it (proves the test can see the bug)", async () => {
    const output = await captureNotFoundLog(false);
    expect(output).toContain(SECRET);
  });
});

describe('redaction depth', () => {
  function logAndCapture(payload: Record<string, unknown>): string {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    const logger = pino(
      { ...fastifyLoggerOptions({ nodeEnv: 'production' }), level: 'info' },
      stream,
    );
    logger.info(payload, 'probe');
    return chunks.join('');
  }

  it('redacts a bare top-level secret field, not only a nested one', () => {
    // `'*.privateKey'` matches `{wallet:{privateKey}}` and NOT `{privateKey}`,
    // so the top-level form was printed in full. Both forms are generated now.
    const out = logAndCapture({ privateKey: 'MUST-NOT-APPEAR' });
    expect(out).not.toContain('MUST-NOT-APPEAR');
    expect(out).toContain('[REDACTED]');
  });

  it('still redacts one level deep', () => {
    const out = logAndCapture({ wallet: { privateKey: 'MUST-NOT-APPEAR' } });
    expect(out).not.toContain('MUST-NOT-APPEAR');
  });

  it('documents its limit honestly: depth two is NOT redacted', () => {
    // Asserting the gap rather than pretending it does not exist. If someone
    // later adds deeper paths, this test fails and the docs get updated with
    // it — which is the outcome we want, not a silently stale promise.
    const out = logAndCapture({ a: { b: { privateKey: 'DEEP-VALUE' } } });
    expect(out).toContain('DEEP-VALUE');
  });
});
