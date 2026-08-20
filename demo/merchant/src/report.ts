/**
 * Deterministic premium market report — the PAID resource in the demo. The
 * gateway is what enforces payment before an agent ever reaches this route;
 * this backend just serves the payload deterministically once called.
 */
import { hashString } from './weather.js';

export interface MarketReportMetric {
  readonly label: string;
  readonly value: string;
  readonly changePercent: number;
}

export interface MarketReport {
  readonly title: string;
  readonly summary: string;
  readonly metrics: readonly MarketReportMetric[];
  readonly generatedAt: string;
}

const REPORT_METRIC_LABELS = [
  'AI Agent Commerce Index',
  'x402 Settlement Volume',
  'MCP Resource Adoption Rate',
] as const;

/** Deterministic market report, as of `now`. Paid resource. */
export function getMarketReport(now: Date): MarketReport {
  const metrics = REPORT_METRIC_LABELS.map((label, index) => {
    const hash = hashString(`${label}#${index}`);
    const value = (100 + (hash % 900)).toFixed(2);
    const changePercent = Number((((hash >>> 8) % 2001) / 100 - 10).toFixed(2)); // -10.00..+10.00

    return { label, value, changePercent };
  });

  return {
    title: 'Weekly Agent Commerce Market Report',
    summary: 'Deterministic demo report payload for the premium/paid resource route.',
    metrics,
    generatedAt: now.toISOString(),
  };
}
