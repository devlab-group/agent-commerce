/**
 * Minimal structural logger interface.
 *
 * Core must not depend on pino directly; the gateway injects a pino instance
 * that satisfies this shape. Never log secrets: private keys, seed phrases,
 * Authorization headers or payment authorisation payloads.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** A logger that discards everything. Useful in unit tests. */
export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};
