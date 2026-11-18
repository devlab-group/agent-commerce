/**
 * Decodes and validates the base64 `PAYMENT-SIGNATURE` submission.
 *
 * A malformed payload must become a `rejected` verification, never a thrown
 * request, so this returns `undefined` on any failure. That is why it parses
 * the schema itself instead of calling the SDK's `decodePaymentSignatureHeader`,
 * which throws.
 */
import { PaymentPayloadV2Schema } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import type { ExactEIP3009Payload, ExactPermit2Payload } from '@x402/evm';
import { isRecord } from '../../core/is-record';
import { isEvmAddress } from './addresses';
import { BAZAAR_EXTENSION_KEY } from './provider/bazaar';

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
 * Build the facilitator payload, dropping the buyer's `resource` and
 * `extensions`. `resource` is optional in v2; verify() checks its URL against
 * the challenge when present. Quote echoes are not used to verify payment,
 * and a gas-sponsoring extension in a Permit2 payload would activate
 * unsupported SDK facilitator behavior.
 *
 * When the `issued` challenge carries Bazaar metadata, attach its `resource`
 * and `extensions.bazaar` for cataloging. The provider passes `issued` only
 * for a facilitator that lists the extension. Use the issued values to keep
 * an altered buyer echo from replacing the listing metadata.
 */
export function forFacilitator<T extends PaymentPayload>(
  payload: T,
  issued: PaymentRequired | undefined,
): Omit<T, 'resource' | 'extensions'> & Pick<Partial<PaymentPayload>, 'resource' | 'extensions'> {
  const { resource: _resource, extensions: _extensions, ...rest } = payload;
  const bazaar = issued?.extensions?.[BAZAAR_EXTENSION_KEY];
  return issued !== undefined && bazaar !== undefined
    ? { ...rest, resource: issued.resource, extensions: { [BAZAAR_EXTENSION_KEY]: bazaar } }
    : rest;
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

// A uint256 in decimal, the form the SDK client writes
const UINT256 = /^(0|[1-9]\d{0,77})$/;
const UINT256_MAX = 2n ** 256n - 1n;
// An EIP-3009 nonce: 32 bytes in hex
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const isUint256 = (value: unknown): value is string =>
  typeof value === 'string' && UINT256.test(value) && BigInt(value) <= UINT256_MAX;

/**
 * Checks an EIP-3009 authorization's fields in the forms the SDK client and
 * mppx write: addresses, decimal uint256 strings and a 32-byte hex nonce. A
 * value such as `"0x2710"` would otherwise reach the receipt as written.
 */
export function hasEip3009Fields(authorization: Readonly<Record<string, unknown>>): boolean {
  return (
    isEvmAddress(authorization['from']) &&
    isEvmAddress(authorization['to']) &&
    isUint256(authorization['value']) &&
    isUint256(authorization['validAfter']) &&
    isUint256(authorization['validBefore']) &&
    typeof authorization['nonce'] === 'string' &&
    BYTES32.test(authorization['nonce'])
  );
}

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
    isEvmAddress(auth['from']) &&
    isEvmAddress(auth['spender']) &&
    isEvmAddress(permitted['token']) &&
    isEvmAddress(witness['to']) &&
    isUint256(permitted['amount']) &&
    isUint256(auth['nonce']) &&
    isUint256(auth['deadline']) &&
    isUint256(witness['validAfter'])
  );
}
