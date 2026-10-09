// Protocol constants shared by the x402 provider's modules
import type { IdGenerator } from '../../../core';

export const X402_VERSION = 2;
export const X402_PROTOCOL_VERSION = String(X402_VERSION);
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_MIME_TYPE = 'application/json';
export const HEALTH_TIMEOUT_MS = 4_000;

/** Prefixed random UUIDs, shared with the MPP rail */
export const DEFAULT_IDS: IdGenerator = {
  next: (prefix?: string) => `${prefix ? `${prefix}_` : ''}${crypto.randomUUID()}`,
};
