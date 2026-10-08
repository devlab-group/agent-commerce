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
import type { ExactEIP3009Payload, ExactPermit2Payload } from '@x402/evm';
import { isRecord } from '../../core/is-record';

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
 * gateway's `resource://` URL. `extensions` is dropped because the gateway
 * advertises none, and the SDK facilitator would act on a gas-sponsoring
 * extension in a Permit2 payload.
 */
export function forFacilitator<T extends PaymentPayload>(
  payload: T,
): Omit<T, 'resource' | 'extensions'> {
  const { resource: _resource, extensions: _extensions, ...rest } = payload;
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
 * Narrows a decoded payload to the EIP-3009 `exact`/EVM shape.
 *
 * The SDK facilitator settles any payload carrying `permit2Authorization`
 * through Permit2, so a payload with both shapes is refused: the gateway would
 * check one authorization and the facilitator would settle the other.
 */
export function isExactEvmPayload(
  payload: PaymentPayload,
): payload is PaymentPayload & { payload: ExactEIP3009Payload } {
  const inner = payload.payload;
  return (
    payload.accepted.scheme === 'exact' &&
    isRecord(inner) &&
    isRecord(inner['authorization']) &&
    !('permit2Authorization' in inner) &&
    typeof inner['signature'] === 'string'
  );
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A uint256 in decimal, the form the SDK client writes
const UINT256 = /^(0|[1-9]\d{0,77})$/;
const UINT256_MAX = 2n ** 256n - 1n;

const isAddressString = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && ADDRESS.test(value);
const isUint256 = (value: unknown): value is string =>
  typeof value === 'string' && UINT256.test(value) && BigInt(value) <= UINT256_MAX;

/**
 * Checks the Permit2 `exact`/EVM fields used to match the offer and derive
 * the replay key. The facilitator checks the signature and on-chain state.
 */
export function isExactPermit2Payload(
  payload: PaymentPayload,
): payload is PaymentPayload & { payload: ExactPermit2Payload } {
  const inner = payload.payload;
  if (payload.accepted.scheme !== 'exact' || !isRecord(inner)) return false;
  const auth = inner['permit2Authorization'];
  if (!isRecord(auth) || 'authorization' in inner || typeof inner['signature'] !== 'string') {
    return false;
  }
  const { permitted, witness } = auth;
  return (
    isRecord(permitted) &&
    isRecord(witness) &&
    isAddressString(auth['from']) &&
    isAddressString(auth['spender']) &&
    isAddressString(permitted['token']) &&
    isAddressString(witness['to']) &&
    isUint256(permitted['amount']) &&
    isUint256(auth['nonce']) &&
    isUint256(auth['deadline']) &&
    isUint256(witness['validAfter'])
  );
}
