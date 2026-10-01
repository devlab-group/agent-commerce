import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { getMarketReport } from '../src/report';
import { getWeather } from '../src/weather';

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

describe('GET /api/weather/:city, a free resource', () => {
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

describe('GET /api/report, a paid resource', () => {
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

  it('reports the three demo metrics as of the injected clock', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/report' });
    const body = res.json<{ generatedAt: string; metrics: { label: string }[] }>();
    expect(body.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(body.metrics.map((metric) => metric.label)).toEqual([
      'AI Agent Commerce Index',
      'x402 Settlement Volume',
      'MCP Resource Adoption Rate',
    ]);
  });
});
