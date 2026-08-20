/**
 * Decoding and validation for the base64 `X-PAYMENT` submission.
 *
 * A malformed payload (not base64, valid base64 but not JSON, valid JSON but
 * the wrong shape) must yield a `rejected` verification result, never a
 * thrown/crashed request — this module returns `undefined` on any failure so
 * callers can turn that into a typed rejection.
 */
import { type ExactEvmPayload, type PaymentPayload, PaymentPayloadSchema } from 'x402/types';

export function decodePaymentSubmission(payloadBase64: string): PaymentPayload | undefined {
  let json: unknown;
  try {
    const decoded = Buffer.from(payloadBase64, 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch {
    return undefined;
  }

  const result = PaymentPayloadSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/** Narrows a decoded payload to the EVM `exact` scheme shape this provider supports. */
export function isExactEvmPayload(
  payload: PaymentPayload,
): payload is PaymentPayload & { payload: ExactEvmPayload } {
  return (
    payload.scheme === 'exact' &&
    typeof payload.payload === 'object' &&
    payload.payload !== null &&
    'authorization' in payload.payload &&
    'signature' in payload.payload
  );
}
