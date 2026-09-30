/**
 * Shortens an address for `doctor` output: enough to eyeball, never the whole
 * value. A value too short to shorten (`length <= keep * 2`) is masked
 * entirely rather than printed whole, so a short secret passed here does not
 * leak.
 */
export function maskMiddle(value: string, keep = 6): string {
  if (value.length <= keep * 2) return value.length === 0 ? value : '…';
  return `${value.slice(0, keep)}…${value.slice(-4)}`;
}
