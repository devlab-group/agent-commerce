/**
 * Pino logger factory with redaction. Never log secrets: Authorization
 * headers, the payment-signature header, private keys, seeds, mnemonics,
 * signatures.
 *
 * Two independent things are built here, deliberately not the same pino
 * instance (Fastify's `loggerInstance` option forces its generic `Logger`
 * type into `FastifyInstance`, which then conflicts with our own `Logger`
 * shape under `exactOptionalPropertyTypes`):
 * - `fastifyLoggerOptions()` — a plain options object handed to Fastify's
 * `logger` option, so Fastify builds its own internally-typed pino
 * instance (still redacted, still pino-pretty in development) for HTTP
 * access logs.
 * - `createGatewayLogger()` — a standalone pino instance wrapped to the
 * `src/core` `Logger` shape, injected into the
 * execution pipeline and protocol adapters.
 * Both share the same redaction paths and level/pretty-print policy.
 */

import { createRequire } from 'node:module';
import type { FastifyReply, FastifyRequest } from 'fastify';
import pino, { type LoggerOptions, type Logger as PinoLogger } from 'pino';
import type { Logger } from '../core/index.js';

/**
 * Absolute path to pino-pretty, or `undefined` when it is not installed.
 *
 * pino-pretty is a **devDependency**: it is a developer-experience nicety and
 * making every consumer of the published package install it (and its
 * transitive tree) to get log lines would be the wrong trade. But the pretty
 * default keys off `NODE_ENV`, which is unset in a normal consumer process —
 * so "development" was inferred and `pino()` threw
 * `unable to determine transport target for "pino-pretty"`, taking down
 * `createGateway()` for anyone importing the library. The clean-consumer test
 * caught it; nothing in the repo could, because here it is always installed.
 *
 * Resolving it ourselves answers the only question that matters — *is it
 * actually there* — and passing the resolved absolute path (rather than the
 * bare name) removes the second failure mode, where pino resolves transport
 * targets from a different directory than we do.
 */
const PINO_PRETTY_PATH: string | undefined = (() => {
  try {
    return createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
})();

// pino/fast-redact paths below are single-level wildcards: '*.privateKey'
// matches privateKey one level deep (e.g. `wallet.privateKey`), not at
// arbitrary nesting (`a.b.privateKey` is not covered). Nothing leaks today
// because every call site funnels through describeError(), which extracts
// only {message, name} before logging — never a raw caught object — but that
// is a property of current call sites, not of this redact config. Do not log
// a raw object that might carry a secret at depth > 1 without either
// extending these paths or hand-picking safe fields first.
const SECRET_FIELD_NAMES = [
  'privateKey',
  'signerPrivateKey',
  'signature',
  'seed',
  'mnemonic',
  'secret',
  'apiKey',
  'adminToken',
  'token',
] as const;

/**
 * The bare top-level form was missing — `'*.privateKey'`
 * matches `{ wallet: { privateKey } }` but not `{ privateKey }`, so a
 * `logger.error({ privateKey })` would have printed it. Both forms are
 * generated now. The depth limit is real and unchanged: fast-redact wildcards
 * are single-level, so a secret at depth ≥ 2 is still not covered, and the
 * documentation says so rather than promising "any field".
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers["payment-signature"]',
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
  /** Raw pino instance, not shared with Fastify — see file header. */
  readonly pino: PinoLogger;
  /** `src/core` `Logger`-shaped wrapper. */
  readonly core: Logger;
}

function baseLoggerOptions(options: CreateGatewayLoggerOptions): LoggerOptions {
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'] ?? 'development';
  // Never spawn a pino-pretty worker thread in tests: many short-lived
  // Fastify/pino instances are created per test run, and pretty-printing is a
  // pure developer-experience nicety, not a functional requirement there.
  const wantPretty = options.prettyPrint ?? (nodeEnv !== 'production' && nodeEnv !== 'test');
  // Asked for *and* available. An explicit `prettyPrint: true` cannot conjure
  // an uninstalled module, so it degrades to JSON rather than throwing —
  // pretty-printing is cosmetic, and losing colour beats losing the gateway.
  const usePretty = wantPretty && PINO_PRETTY_PATH !== undefined;

  return {
    level: options.level ?? process.env['LOG_LEVEL'] ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    ...(options.name !== undefined ? { name: options.name } : {}),
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    ...(usePretty ? { transport: { target: PINO_PRETTY_PATH as string } } : {}),
  };
}

/**
 * Strips the query string from a request URL before it reaches a log line
 * or an echoed-back response body. The admin token is header-only, with no
 * `?adminToken=` exception for the SSE route (see access-control.ts's doc
 * comment), so this is not the only thing keeping it out of logs — but any
 * query parameter, on any route, could carry something sensitive, and a
 * blanket redaction costs nothing to keep. Single source of truth: every place that puts a
 * request URL in front of a log or a client must call this, not re-derive
 * its own redaction — two redactors drift (Fastify's
 * default 404 handler built its own message string from the raw URL,
 * bypassing the `req` serializer below entirely; see server.ts's
 * `setNotFoundHandler`, which uses this same function).
 */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : `${url.slice(0, queryIndex)}?[REDACTED]`;
}

/** Overrides (not extends) Fastify's default `req` serializer — see sanitizeUrl. */
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

/** Plain options object for Fastify's own `logger` option (see file header). */
export function fastifyLoggerOptions(options: CreateGatewayLoggerOptions = {}): LoggerOptions {
  return {
    ...baseLoggerOptions(options),
    serializers: { req: redactedReqSerializer },
  };
}

/**
 * Fastify's own default 404 handler (four-oh-four.js's `basic404` ->
 * log-controller.js's `routeNotFound`) builds its log line by interpolating
 * `request.raw.url` into a template string — bypassing the `req` serializer
 * above entirely, since it's a plain string, not a structured log call.
 * Registering a `setNotFoundHandler` replaces Fastify's internal one outright
 * (it is only ever invoked when none is set), so this is the only fix point.
 * Exported (not inlined in server.ts) so production and tests share the exact
 * same handler — a second, test-only reimplementation is exactly the kind of
 * thing that quietly drifts from what actually ships.
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
