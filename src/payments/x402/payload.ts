/**
 * Decodes and validates the base64 `PAYMENT-SIGNATURE` submission.
 *
 * A malformed payload must become a `rejected` verification, never a thrown
 * request, so this returns `undefined` on any failure. That is why it parses
 * the schema itself instead of calling the SDK's `decodePaymentSignatureHeader`,
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
 * The `exact` scheme on EVM also has a Permit2 method. The challenge names
 * EIP-3009 (`extra.assetTransferMethod`), and a Permit2 payload is rejected
 * here rather than handed to the SDK. On the local chain, which has no Permit2
 * proxy, it would fail as an opaque settlement revert.
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
