/**
 * Decoding and validation for the base64 `PAYMENT-SIGNATURE` submission.
 *
 * A malformed payload (not base64, valid base64 but not JSON, valid JSON but
 * the wrong shape) must yield a `rejected` verification result, never a
 * thrown/crashed request — this module returns `undefined` on any failure so
 * callers can turn that into a typed rejection. That is why it parses the
 * schema itself rather than calling the SDK's `decodePaymentSignatureHeader`,
 * which throws.
 */
import { PaymentPayloadV2Schema } from '@x402/core/schemas';
import type { PaymentPayload } from '@x402/core/types';
import { type ExactEIP3009Payload, isEIP3009Payload } from '@x402/evm';

export function decodePaymentSubmission(payloadBase64: string): PaymentPayload | undefined {
  let json: unknown;
  try {
    const decoded = Buffer.from(payloadBase64, 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch {
    return undefined;
  }

  const result = PaymentPayloadV2Schema.safeParse(json);
  return result.success ? (result.data as PaymentPayload) : undefined;
}

/**
 * Narrows a decoded payload to the EIP-3009 `exact`/EVM shape this provider
 * settles.
 *
 * x402 v2's `exact` scheme on EVM has two asset-transfer methods — EIP-3009
 * `transferWithAuthorization` and Permit2. Only the first is supported here,
 * and the challenge says so (`extra.assetTransferMethod`), so a Permit2
 * payload arriving anyway is rejected rather than handed to the SDK: the
 * Permit2 proxy is not deployed on the local chain and a failure there would
 * surface as an opaque settlement revert instead of a clear rejection.
 */
export function isExactEvmPayload(
  payload: PaymentPayload,
): payload is PaymentPayload & { payload: ExactEIP3009Payload } {
  return (
    payload.accepted.scheme === 'exact' &&
    typeof payload.payload === 'object' &&
    payload.payload !== null &&
    isEIP3009Payload(payload.payload as ExactEIP3009Payload) &&
    typeof (payload.payload as ExactEIP3009Payload).signature === 'string'
  );
}
