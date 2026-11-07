/** Maximum `Idempotency-Key` length for ACP and MPP */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

// Keys can be echoed in response headers and unlock stored responses.
// Printable ASCII prevents CRLF response splitting; errors must not expose the key.
const USABLE_KEY = new RegExp(`^[\\x20-\\x7e]{1,${MAX_IDEMPOTENCY_KEY_LENGTH}}$`);

/** True for 1 to 255 printable ASCII characters */
export function isUsableIdempotencyKey(value: string): boolean {
  return USABLE_KEY.test(value);
}
