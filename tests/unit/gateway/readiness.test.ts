import { describe, expect, it } from 'vitest';
import type { Clock, Logger } from '../../../src/core';
import { createReadinessProbe } from '../../../src/gateway/readiness';
import { createFakePaymentProvider, createFakeStore } from './helpers';

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
      authorizationProviders: [],
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
      {
        store,
        adapterRuntimes: [],
        paymentProviders: [],
        authorizationProviders: [],
        clock,
        logger: NOOP_LOGGER,
      },
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
      {
        store,
        adapterRuntimes: [],
        paymentProviders: [],
        authorizationProviders: [],
        clock,
        logger: NOOP_LOGGER,
      },
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
      {
        store,
        adapterRuntimes: [],
        paymentProviders: [],
        authorizationProviders: [],
        clock,
        logger: NOOP_LOGGER,
      },
      100,
    );

    expect((await probe.check()).ready).toBe(true);
    store.healthStatus = 'fail';
    clock.advance(101);
    expect((await probe.check()).ready).toBe(false);
  });
});

describe('readiness logging', () => {
  // At the default info level, warn explains a returned failure behind /ready's 503
  it('logs a failing detail at warn once per outage, and at debug while it lasts', async () => {
    const lines: Array<{ level: string; entry: Record<string, unknown> }> = [];
    const record =
      (level: string) =>
      (entry: Record<string, unknown>): void => {
        lines.push({ level, entry });
      };
    const logger: Logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      child: () => logger,
    };
    let status: 'pass' | 'fail' = 'fail';
    const provider = {
      ...createFakePaymentProvider(),
      health: async () => ({ status, checkedAt: 'x', detail: 'rpc https://rpc.example timed out' }),
    };
    const clock = createFakeClock();
    const probe = createReadinessProbe(
      {
        store: createFakeStore(),
        adapterRuntimes: [],
        paymentProviders: [provider],
        authorizationProviders: [],
        clock,
        logger,
      },
      100,
    );
    const warnings = () =>
      lines.filter(
        ({ level, entry }) =>
          level === 'warn' && entry['detail'] === 'rpc https://rpc.example timed out',
      ).length;

    expect((await probe.check()).ready).toBe(false);
    clock.advance(101);
    await probe.check();
    expect(warnings()).toBe(1);
    expect(lines.filter(({ level }) => level === 'debug')).toHaveLength(1);

    // Recovery clears the failure marker, so the next failure warns again
    status = 'pass';
    clock.advance(101);
    expect((await probe.check()).ready).toBe(true);
    status = 'fail';
    clock.advance(101);
    await probe.check();
    expect(warnings()).toBe(2);
  });
});
