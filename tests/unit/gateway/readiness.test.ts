import { describe, expect, it } from 'vitest';
import type { Clock, Logger } from '../../../src/core/index.js';
import { createReadinessProbe } from '../../../src/gateway/readiness.js';
import { createFakePaymentProvider, createFakeStore } from './helpers.js';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

function createFakeClock(startMs = 0): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  return {
    now: () => new Date(now),
    nowIso: () => new Date(now).toISOString(),
    monotonicMs: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('createReadinessProbe', () => {
  it('collapses a burst of concurrent callers onto one real evaluation', async () => {
    const store = createFakeStore();
    let healthCalls = 0;
    store.health = async () => {
      healthCalls += 1;
      return { status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' };
    };
    const provider = {
      ...createFakePaymentProvider(),
      health: async () => ({ status: 'pass' as const, checkedAt: 'x' }),
    };
    const clock = createFakeClock();

    const probe = createReadinessProbe({
      store,
      adapterRuntimes: [],
      paymentProviders: [provider],
      clock,
      logger: NOOP_LOGGER,
    });

    const results = await Promise.all([probe.check(), probe.check(), probe.check(), probe.check()]);
    expect(healthCalls).toBe(1);
    for (const result of results) expect(result.ready).toBe(true);
  });

  it('serves a cached result within the TTL without calling health() again', async () => {
    const store = createFakeStore();
    let healthCalls = 0;
    store.health = async () => {
      healthCalls += 1;
      return { status: 'pass', checkedAt: 'x' };
    };
    const clock = createFakeClock();
    const probe = createReadinessProbe(
      { store, adapterRuntimes: [], paymentProviders: [], clock, logger: NOOP_LOGGER },
      2000,
    );

    await probe.check();
    clock.advance(1000);
    await probe.check();
    expect(healthCalls).toBe(1);
  });

  it('re-evaluates once the TTL has elapsed', async () => {
    const store = createFakeStore();
    let healthCalls = 0;
    store.health = async () => {
      healthCalls += 1;
      return { status: 'pass', checkedAt: 'x' };
    };
    const clock = createFakeClock();
    const probe = createReadinessProbe(
      { store, adapterRuntimes: [], paymentProviders: [], clock, logger: NOOP_LOGGER },
      2000,
    );

    await probe.check();
    clock.advance(2001);
    await probe.check();
    expect(healthCalls).toBe(2);
  });

  it('reflects a change in health once the cache expires (not stuck on a stale answer)', async () => {
    const store = createFakeStore();
    store.healthStatus = 'pass';
    const clock = createFakeClock();
    const probe = createReadinessProbe(
      { store, adapterRuntimes: [], paymentProviders: [], clock, logger: NOOP_LOGGER },
      100,
    );

    expect((await probe.check()).ready).toBe(true);
    store.healthStatus = 'fail';
    clock.advance(101);
    expect((await probe.check()).ready).toBe(false);
  });
});
