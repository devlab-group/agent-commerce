import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getMarketReport } from '../src/report.js';
import { getWeather } from '../src/weather.js';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

describe('GET /api/health', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logger: false, now: () => FIXED_NOW });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns { status: "ok" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/weather/:city — free resource', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logger: false, now: () => FIXED_NOW });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a deterministic reading matching the pure function directly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/weather/Paris' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(getWeather('Paris', FIXED_NOW));
  });

  it('is deterministic across repeated calls for the same city', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/weather/Tokyo' });
    const second = await app.inject({ method: 'GET', url: '/api/weather/Tokyo' });
    expect(first.json()).toEqual(second.json());
  });

  it('produces different values for different cities', async () => {
    const paris = await app.inject({ method: 'GET', url: '/api/weather/Paris' });
    const tokyo = await app.inject({ method: 'GET', url: '/api/weather/Tokyo' });
    expect(paris.json()).not.toEqual(tokyo.json());
  });

  it('pins an exact value for a fixed city and clock (regression guard)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/weather/Springfield' });
    expect(res.json()).toEqual({
      city: 'Springfield',
      temperatureC: 24,
      condition: 'fog',
      humidityPercent: 30,
      windKph: 34,
      observedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('rejects a blank city with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/weather/%20' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/report — paid resource', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logger: false, now: () => FIXED_NOW });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a deterministic report matching the pure function directly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/report' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(getMarketReport(FIXED_NOW));
  });

  it('is deterministic across repeated calls', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/report' });
    const second = await app.inject({ method: 'GET', url: '/api/report' });
    expect(first.json()).toEqual(second.json());
  });

  it('includes non-empty metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/report' });
    const body = res.json();
    expect(Array.isArray(body.metrics)).toBe(true);
    expect(body.metrics.length).toBeGreaterThan(0);
  });
});

describe('GET /api/fail — demo-only failure injection', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logger: false, now: () => FIXED_NOW });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the requested status code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fail?status=503' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 503 });
  });

  it('defaults to 500 when no status is given', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fail' });
    expect(res.statusCode).toBe(500);
  });

  it('rejects an out-of-range status with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fail?status=999' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-numeric status with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fail?status=abc' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/slow — demo-only latency injection', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logger: false, now: () => FIXED_NOW });
  });

  afterEach(async () => {
    await app.close();
  });

  it('sleeps for at least the requested duration before responding', async () => {
    const start = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/slow?ms=50' });
    const elapsed = Date.now() - start;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', sleptMs: 50 });
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it('defaults to 1000ms when ms is not given', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/slow?ms=0' });
    expect(res.json()).toEqual({ status: 'ok', sleptMs: 0 });
  });

  it('rejects a negative ms with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/slow?ms=-1' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-numeric ms with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/slow?ms=nope' });
    expect(res.statusCode).toBe(400);
  });

  // An unbounded ms=2147483647 holds a connection open for ~24 days. Bound it
  // to something a real timeout test would ever need.
  it('rejects ms above the 30s ceiling with 400', async () => {
    const tooLong = await app.inject({ method: 'GET', url: '/api/slow?ms=2147483647' });
    expect(tooLong.statusCode).toBe(400);
    const justOver = await app.inject({ method: 'GET', url: '/api/slow?ms=30001' });
    expect(justOver.statusCode).toBe(400);
  });
});

describe('demo failure-injection routes are gated by NODE_ENV', () => {
  it('are registered by default (not production)', async () => {
    const app = buildApp({ logger: false });
    try {
      const slow = await app.inject({ method: 'GET', url: '/api/slow?ms=0' });
      const fail = await app.inject({ method: 'GET', url: '/api/fail?status=418' });
      expect(slow.statusCode).toBe(200);
      expect(fail.statusCode).toBe(418);
    } finally {
      await app.close();
    }
  });

  it('are absent when enableDemoFailureRoutes is explicitly false', async () => {
    const app = buildApp({ logger: false, enableDemoFailureRoutes: false });
    try {
      const slow = await app.inject({ method: 'GET', url: '/api/slow?ms=0' });
      const fail = await app.inject({ method: 'GET', url: '/api/fail?status=418' });
      expect(slow.statusCode).toBe(404);
      expect(fail.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('default off when NODE_ENV=production and no explicit override is given', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = buildApp({ logger: false });
      try {
        const slow = await app.inject({ method: 'GET', url: '/api/slow?ms=0' });
        expect(slow.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
