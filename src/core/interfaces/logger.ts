/**
 * Minimal structural logger. Core does not depend on pino; the gateway injects
 * a pino instance that satisfies this shape.
 *
 * Never log secrets: private keys, seed phrases, Authorization headers or
 * payment authorization payloads.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** A logger that discards everything */
export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};
