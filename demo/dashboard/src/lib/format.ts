import type { AdapterHealth, Pricing } from './types.js';

export function formatPrice(pricing: Pricing): string {
  switch (pricing.type) {
    case 'free':
      return 'Free';
    case 'fixed':
      return `${pricing.amount} ${pricing.currency}`;
    case 'dynamic':
      return 'Dynamic (resolved at request time)';
  }
}

export function formatProtocols(exposedVia: readonly string[]): string {
  return exposedVia.length > 0 ? exposedVia.join(', ') : '(none)';
}

/** Uppercased status label, used consistently for adapter status and health status. */
export function formatStatusLabel(status: string): string {
  return status.toUpperCase();
}

export function formatHealth(health: AdapterHealth): string {
  return health.detail !== undefined
    ? `${formatStatusLabel(health.status)} — ${health.detail}`
    : formatStatusLabel(health.status);
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Short, locale time-of-day for a table row. Falls back to the raw string if unparsable. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME_FORMATTER.format(date);
}

/** Shortens a requestId for compact display while staying visually matchable across panels. */
export function shortenRequestId(requestId: string): string {
  return requestId.length > 12 ? `${requestId.slice(0, 12)}…` : requestId;
}
