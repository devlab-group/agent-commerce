/**
 * Pino logger factory that redacts the credential and proof headers in
 * `SECRET_HEADERS` and the fields named in `SECRET_FIELD_NAMES`.
 *
 * Two separate pino instances, because Fastify's `loggerInstance` option forces
 * its generic `Logger` type into `FastifyInstance`, which conflicts with our
 * `Logger` shape under `exactOptionalPropertyTypes`:
 * - `fastifyLoggerOptions()`: options for Fastify's `logger` option, so
 * Fastify builds its own instance for HTTP access logs.
 * - `createGatewayLogger()`: a standalone instance wrapped to the `src/core`
 * `Logger` shape, injected into the pipeline and protocol adapters.
 * Both share the redaction paths and the level and pretty-print policy.
 */

import { createRequire } from 'node:module';
import type { FastifyReply, FastifyRequest } from 'fastify';
import pino, { type LoggerOptions, type Logger as PinoLogger } from 'pino';
import { AUTHORIZATION_HEADER, type Logger, PAYMENT_HEADER } from '../core';

/**
 * Absolute path to pino-pretty, or `undefined` when it is not installed.
 *
 * pino-pretty is a devDependency, so a consumer of the published package
 * usually lacks it, yet an unset `NODE_ENV` still selects the pretty default.
 * An unresolvable transport makes `pino()` throw and takes `createGateway()`
 * down with it. Passing the absolute path also stops pino resolving the
 * target from a different directory than this module.
 */
const PINO_PRETTY_PATH: string | undefined = (() => {
  try {
    return createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
})();

// Each name is redacted at the top level and one level down ('*.privateKey'
// matches `wallet.privateKey`). Pino's redact wildcards are single-level, so
// `a.b.privateKey` is not covered: never put a secret in error details or log
// a raw object that may nest one deeper without extending these paths.
const SECRET_FIELD_NAMES = [
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
] as const;

// Credential and proof headers. The proof headers come from the wire constants,
// so a renamed one stays redacted; `agent-authorization` carries an AP2 mandate.
const SECRET_HEADERS = ['authorization', PAYMENT_HEADER, AUTHORIZATION_HEADER] as const;

export const REDACT_PATHS: readonly string[] = [
  ...SECRET_HEADERS.map((name) => `req.headers[${JSON.stringify(name)}]`),
  ...SECRET_FIELD_NAMES,
  ...SECRET_FIELD_NAMES.map((name) => `*.${name}`),
];

export interface CreateGatewayLoggerOptions {
  readonly level?: string;
  readonly name?: string;
  readonly nodeEnv?: string;
  readonly prettyPrint?: boolean;
}

export interface CreatedGatewayLogger {
  /** Raw pino instance, not shared with Fastify (see file header) */
  readonly pino: PinoLogger;
  /** `src/core` `Logger`-shaped wrapper */
  readonly core: Logger;
}

function baseLoggerOptions(options: CreateGatewayLoggerOptions): LoggerOptions {
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'] ?? 'development';
  // No pino-pretty worker thread in tests, which create many short-lived loggers
  const wantPretty = options.prettyPrint ?? (nodeEnv !== 'production' && nodeEnv !== 'test');
  // Even an explicit `prettyPrint: true` falls back to JSON when pino-pretty
  // is missing, rather than throwing
  const usePretty = wantPretty && PINO_PRETTY_PATH !== undefined;

  return {
    level: options.level ?? process.env['LOG_LEVEL'] ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    ...(options.name !== undefined ? { name: options.name } : {}),
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    ...(usePretty ? { transport: { target: PINO_PRETTY_PATH as string } } : {}),
  };
}

/**
 * Replaces a URL's query string with `?[REDACTED]` before it reaches a log line
 * or a response body: the admin token is header only, but any query parameter
 * on any route may carry something sensitive. Every place that shows a request
 * URL to a log or a client calls this instead of redacting its own way.
 */
function sanitizeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : `${url.slice(0, queryIndex)}?[REDACTED]`;
}

// Replaces Fastify's default `req` serializer, so the logged URL is sanitized
function redactedReqSerializer(req: {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}): Record<string, unknown> {
  return {
    method: req.method,
    url: sanitizeUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/** Options for Fastify's own `logger` option (see file header) */
export function fastifyLoggerOptions(options: CreateGatewayLoggerOptions = {}): LoggerOptions {
  return {
    ...baseLoggerOptions(options),
    serializers: { req: redactedReqSerializer },
  };
}

/**
 * Replaces Fastify's default 404 handler, whose log line interpolates
 * `request.raw.url` into a plain string and so bypasses the `req` serializer.
 * Exported so the tests exercise the handler that ships.
 */
export function buildNotFoundHandler(): (request: FastifyRequest, reply: FastifyReply) => void {
  return (request, reply) => {
    const safeUrl = sanitizeUrl(request.raw.url) ?? '';
    const message = `Route ${request.method}:${safeUrl} not found`;
    request.log.info(message);
    reply.code(404).send({ message, error: 'Not Found', statusCode: 404 });
  };
}

export function createGatewayLogger(
  options: CreateGatewayLoggerOptions = {},
): CreatedGatewayLogger {
  const instance = pino(baseLoggerOptions(options));
  return { pino: instance, core: wrapPino(instance) };
}

function wrapPino(instance: PinoLogger): Logger {
  const logger: Logger = {
    debug: (obj, msg) => instance.debug(obj, msg),
    info: (obj, msg) => instance.info(obj, msg),
    warn: (obj, msg) => instance.warn(obj, msg),
    error: (obj, msg) => instance.error(obj, msg),
    child: (bindings) => wrapPino(instance.child(bindings)),
  };
  return logger;
}
