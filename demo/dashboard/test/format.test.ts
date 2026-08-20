import { describe, expect, it } from 'vitest';
import {
  formatHealth,
  formatPrice,
  formatProtocols,
  formatStatusLabel,
  formatTimestamp,
  shortenRequestId,
} from '../src/lib/format.js';

describe('formatPrice', () => {
  it('renders a free resource', () => {
    expect(formatPrice({ type: 'free' })).toBe('Free');
  });

  it('renders a fixed price with amount and currency', () => {
    expect(formatPrice({ type: 'fixed', amount: '0.01', currency: 'USDC' })).toBe('0.01 USDC');
  });

  it('renders a dynamic price generically', () => {
    expect(formatPrice({ type: 'dynamic', resolver: 'some-resolver' })).toContain('Dynamic');
  });
});

describe('formatProtocols', () => {
  it('joins multiple protocols', () => {
    expect(formatProtocols(['http', 'mcp'])).toBe('http, mcp');
  });

  it('shows a placeholder for no protocols', () => {
    expect(formatProtocols([])).toBe('(none)');
  });
});

describe('formatStatusLabel / formatHealth', () => {
  it('uppercases a status label', () => {
    expect(formatStatusLabel('pass')).toBe('PASS');
  });

  it('includes the detail when present', () => {
    expect(
      formatHealth({ status: 'warn', detail: 'slow', checkedAt: '2026-01-01T00:00:00.000Z' }),
    ).toBe('WARN — slow');
  });

  it('omits the dash when there is no detail', () => {
    expect(formatHealth({ status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' })).toBe('PASS');
  });
});

describe('formatTimestamp', () => {
  it('formats a valid ISO timestamp', () => {
    const formatted = formatTimestamp('2026-01-01T12:34:56.000Z');
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).not.toBe('2026-01-01T12:34:56.000Z');
  });

  it('falls back to the raw string for an unparsable timestamp', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('shortenRequestId', () => {
  it('leaves a short id unchanged', () => {
    expect(shortenRequestId('req_1')).toBe('req_1');
  });

  it('truncates a long id with an ellipsis', () => {
    const id = 'req_0123456789abcdef';
    const shortened = shortenRequestId(id);
    expect(shortened.length).toBeLessThan(id.length);
    expect(shortened.endsWith('…')).toBe(true);
  });
});
