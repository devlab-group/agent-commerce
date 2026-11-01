// Normalizes caller values before they reach a query
import { CommerceError, type IsoTimestamp } from '../../core';

const DEFAULT_LIST_LIMIT = 50;
/**
 * Cap paginated lists for HTTP and direct store callers. SQLite treats a
 * negative `LIMIT` as unlimited, so `{ limit: -1 }` would otherwise return
 * the whole table.
 */
const MAX_LIST_LIMIT = 500;

/**
 * Clamp to a whole number in [1, MAX_LIST_LIMIT], using the default for an
 * absent or non-finite limit (NaN, Infinity), regardless of caller validation
 */
export function clampListLimit(limit: number | undefined): number {
  const base = limit !== undefined && Number.isFinite(limit) ? limit : DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(base), 1), MAX_LIST_LIMIT);
}

/**
 * Normalize a caller's timestamp to UTC with `toISOString()` so expiry
 * comparisons use one format rather than mixing offsets
 */
export function storedIso(value: IsoTimestamp, field: string): IsoTimestamp {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new CommerceError('STORAGE_ERROR', `${field} is not a valid timestamp`);
  }
  return new Date(ms).toISOString();
}
