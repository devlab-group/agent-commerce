/**
 * Safe, visible-but-non-secret display of an address/destination for
 * `doctor`. Shows enough to eyeball correctness without ever printing a full
 * value that could be sensitive-adjacent (e.g. an RPC URL with an embedded
 * API key).
 *
 * Returning the value whole when it is short enough (`length <= keep * 2`)
 * would contradict the promise above — harmless for the 42-character
 * addresses this is used on today, and a trap for the next caller who reaches
 * for it with a short secret. A short value is masked entirely instead.
 */
export function maskMiddle(value: string, keep = 6): string {
  if (value.length <= keep * 2) return value.length === 0 ? value : '…';
  return `${value.slice(0, keep)}…${value.slice(-4)}`;
}
