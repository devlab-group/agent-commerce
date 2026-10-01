import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import pino, { type Logger as PinoLogger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORIZATION_HEADER, PAYMENT_HEADER } from '../../../src/core';
import {
  buildNotFoundHandler,
  createGatewayLogger,
  fastifyLoggerOptions,
  REDACT_PATHS,
} from '../../../src/gateway/logger';

// Parsed lines a createGatewayLogger instance writes. Its children share the
// root's destination stream, so they are captured too.
function captureLines(root: PinoLogger): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const stream = (root as unknown as Record<symbol, { write(chunk: string): boolean }>)[
    pino.symbols.streamSym
  ];
  if (stream === undefined) throw new Error('pino destination stream not found');
  vi.spyOn(stream, 'write').mockImplementation((chunk: string) => {
    lines.push(JSON.parse(chunk) as Record<string, unknown>);
    return true;
  });
  return lines;
}

describe('createGatewayLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts configured secret-shaped paths from logged output', () => {
    const { pino: root, core } = createGatewayLogger({ level: 'info', prettyPrint: false });
    const lines = captureLines(root);

    core.info({ wallet: { signerPrivateKey: '0xSUPER_SECRET' } }, 'facilitator configured');
    core.info(
      {
        req: {
          headers: {
            authorization: 'Bearer secret-token',
            'payment-signature': 'base64proof',
            'agent-authorization': 'base64mandate',
            'content-type': 'application/json',
          },
        },
      },
      'request',
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ wallet: { signerPrivateKey: '[REDACTED]' } });
    expect(lines[1]).toMatchObject({
      req: {
        headers: {
          authorization: '[REDACTED]',
          'payment-signature': '[REDACTED]',
          'agent-authorization': '[REDACTED]',
          'content-type': 'application/json',
        },
      },
    });
  });

  it('redacts every wire header that carries a credential or a proof', () => {
    // Asserts the redaction, not the spelling of the path: a new header
    // constant with no path has to fail here, and rewriting an existing path
    // in another notation that still redacts must not
    for (const header of ['authorization', PAYMENT_HEADER, AUTHORIZATION_HEADER]) {
      const { pino: root, core } = createGatewayLogger({ level: 'info', prettyPrint: false });
      const lines = captureLines(root);

      core.info({ req: { headers: { [header]: 'SENSITIVE-VALUE' } } }, 'request');

      expect(lines, header).toHaveLength(1);
      expect(lines[0]?.['req'], header).toEqual({ headers: { [header]: '[REDACTED]' } });
    }
  });

  it('writes each Logger method at its own level, and a child keeps its bindings and the redaction', () => {
    const { pino: root, core } = createGatewayLogger({ level: 'debug', prettyPrint: false });
    const lines = captureLines(root);
    const child = core.child({ requestId: 'req-1' });

    child.debug({ apiKey: 'should-be-redacted' }, 'at-debug');
    child.info({ apiKey: 'should-be-redacted' }, 'at-info');
    child.warn({ apiKey: 'should-be-redacted' }, 'at-warn');
    child.error({ apiKey: 'should-be-redacted', amount: '0.01' }, 'at-error');

    expect(lines.map((line) => [line['level'], line['msg']])).toEqual([
      [20, 'at-debug'],
      [30, 'at-info'],
      [40, 'at-warn'],
      [50, 'at-error'],
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ requestId: 'req-1', apiKey: '[REDACTED]' });
    }
    expect(lines[3]?.['amount']).toBe('0.01');
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
    // pino-pretty is a devDependency: always present here, never guaranteed in a
    // consumer, and `pino()` throws on a target it cannot resolve. This repo can
    // check that the target resolves; CI's clean-consumer step covers its absence.
    const options = fastifyLoggerOptions({ nodeEnv: 'development' });
    const target = (options.transport as { target?: string } | undefined)?.target;
    expect(target).toBeDefined();
    expect(isAbsolute(target as string)).toBe(true);
    expect(existsSync(target as string)).toBe(true);
  });

  it('degrades to JSON rather than throwing when pino-pretty cannot be resolved', async () => {
    // A consumer install usually lacks pino-pretty. The test above, where it
    // resolves, is the control.
    vi.resetModules();
    vi.doMock('node:module', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:module')>()),
      createRequire: () => ({
        resolve: () => {
          throw new Error("Cannot find module 'pino-pretty'");
        },
      }),
    }));
    try {
      const logger = await import('../../../src/gateway/logger');
      expect(logger.fastifyLoggerOptions({ prettyPrint: true }).transport).toBeUndefined();
      expect(() =>
        logger.createGatewayLogger({ level: 'silent', prettyPrint: true }),
      ).not.toThrow();
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
  });

  it('redacts the query string from the logged request URL (?adminToken=)', () => {
    const options = fastifyLoggerOptions({ level: 'silent' });
    const reqSerializer = options.serializers?.['req'] as (req: unknown) => Record<string, unknown>;
    expect(typeof reqSerializer).toBe('function');

    const serialized = reqSerializer({
      method: 'GET',
      url: '/api/events?adminToken=super-secret-token',
      host: 'localhost:8080',
      ip: '127.0.0.1',
      socket: { remotePort: 5555 },
    });

    expect(serialized['url']).toBe('/api/events?[REDACTED]');
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
  // Real Fastify and pino in production mode: a pino-pretty transport writes
  // from a worker thread that a stdout patch cannot capture. `stream:` is pino's
  // supported redirect, and Fastify passes it through to `pino(opts, opts.stream)`.
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

  it('does not put the admin token in the captured production log line on a 404', async () => {
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

  // The key material, credentials and proofs the gateway handles. Listed here
  // rather than read from logger.ts, so removing a name there fails here.
  it.each([
    'privateKey',
    'signerPrivateKey',
    'signature',
    'seed',
    'mnemonic',
    'secret',
    'challengeSecret',
    'apiKey',
    'adminToken',
    'token',
  ])('redacts a "%s" field at the top level and one level down', (name) => {
    // `'*.privateKey'` matches `{wallet:{privateKey}}` but not `{privateKey}`,
    // so the bare path is generated too
    const out = logAndCapture({ [name]: 'MUST-NOT-APPEAR', wallet: { [name]: 'MUST-NOT-APPEAR' } });
    expect(JSON.parse(out)).toMatchObject({
      msg: 'probe',
      [name]: '[REDACTED]',
      wallet: { [name]: '[REDACTED]' },
    });
  });

  it('documents its limit: depth two is NOT redacted', () => {
    // Pins the gap described in logger.ts: adding deeper paths fails this
    // test, so that comment gets updated with it
    const out = logAndCapture({ a: { b: { privateKey: 'DEEP-VALUE' } } });
    expect(out).toContain('DEEP-VALUE');
  });
});
