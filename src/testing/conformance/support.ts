// Shared conformance helpers use core types and node:assert/strict, so store
// implementations can run the cases with any test runner
import assert from 'node:assert/strict';
import type { Clock, IsoTimestamp, ReceiptStore } from '../../core';

/** Instant every case starts from */
export const START_MS = Date.parse('2026-01-01T00:00:00.000Z');

/** The suite's clock. Reads repeat the same instant until a case advances it */
export interface ConformanceClock extends Clock {
  advance(ms: number): void;
}

export function createConformanceClock(): ConformanceClock {
  let current = START_MS;
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    monotonicMs: () => current - START_MS,
    advance(ms) {
      current += ms;
    },
  };
}

/** `START_MS` plus `offsetMs`, as an ISO timestamp */
export function isoAt(offsetMs: number): IsoTimestamp {
  return new Date(START_MS + offsetMs).toISOString();
}

export interface CaseEnv {
  readonly store: ReceiptStore;
  readonly clock: ConformanceClock;
  /** Close the store and open the same data; only cases with `needsReopen` may call it */
  reopen(): Promise<ReceiptStore>;
}

export interface CaseSpec {
  readonly name: string;
  /** Optional methods the case calls; the case is skipped when the store lacks one */
  readonly uses?: readonly (keyof ReceiptStore)[];
  /** Skipped when the factory supplies no `reopen()` */
  readonly needsReopen?: boolean;
  run(env: CaseEnv): Promise<void>;
}

/** Assert that `promise` rejects with a matching `code` field and return the error */
export async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<unknown> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  });
  return caught;
}
