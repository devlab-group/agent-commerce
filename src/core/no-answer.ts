// Classify transport failures for health checks and `doctor` diagnostics

// Node and undici transport errors classified as unreachable. Configuration
// failures such as ENOTFOUND, TLS/certificate errors and rejected ports stay
// unmarked.
const NO_ANSWER_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Identify known transport failures for health checks and `doctor`. Search a
 * bounded cause chain for the codes above, `TimeoutError` (used by
 * `AbortSignal.timeout` and viem), or a name in `timeoutNames`. Return false
 * for unrecognized errors so configuration failures are not treated as outages.
 */
export function gotNoAnswer(err: unknown, timeoutNames: readonly string[] = []): boolean {
  let cause = err;
  // The bound stops a cause cycle
  for (let depth = 0; depth < 10 && cause instanceof Error; depth++) {
    if (cause.name === 'TimeoutError' || timeoutNames.includes(cause.name)) return true;
    const { code } = cause as { code?: unknown };
    if (typeof code === 'string' && NO_ANSWER_CODES.has(code)) return true;
    cause = cause.cause;
  }
  return false;
}
