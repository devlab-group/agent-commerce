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
  const json = decodeJson(payloadBase64);
  if (json === undefined) return undefined;
  const result = PaymentPayloadV2Schema.safeParse(json);
  return result.success ? (result.data as PaymentPayload) : undefined;
}

/** Read the declared version before v2 schema validation */
export function declaredX402Version(payloadBase64: string): unknown {
  const json = decodeJson(payloadBase64);
  return typeof json === 'object' && json !== null
    ? (json as Record<string, unknown>)['x402Version']
    : undefined;
}

/**
 * The payload as sent to a facilitator. `resource` is optional in v2 and
 * verify() has already matched it against the offer; hosted facilitators have
 * settled payloads without it, and none has been shown to accept this
 * gateway's `resource://` URL
 */
export function withoutResource<T extends PaymentPayload>(payload: T): Omit<T, 'resource'> {
  const { resource: _resource, ...rest } = payload;
  return rest;
}

function decodeJson(payloadBase64: string): unknown {
  try {
    return JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
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
