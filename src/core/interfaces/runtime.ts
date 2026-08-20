/**
 * Injected runtime primitives.
 *
 * Everything non-deterministic (time, ids) is injected so tests can be exact.
 */
import type { IsoTimestamp } from '../domain/common.js';

export interface Clock {
  now(): Date;
  nowIso(): IsoTimestamp;
  /** Milliseconds since an arbitrary origin; use for durations only. */
  monotonicMs(): number;
}

export interface IdGenerator {
  /** Opaque, collision-resistant identifier. */
  next(prefix?: string): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};
