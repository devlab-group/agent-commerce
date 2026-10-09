// Reading an MPP credential: its decoding, its binding to the challenge, and the x402 proof it carries
import { type Challenge, Credential, Errors, PaymentRequest } from 'mppx';
import type { Types } from 'mppx/evm';
import { getAddress, isAddress } from 'viem';
import type { PaymentRequirement, PaymentSubmission } from '../../core';

// mppx reports a verification failure only as message text. The pinned
// release's wording maps to stable reasons, and the tests cover every entry;
// unmapped text becomes `authorization_invalid`.
const VERIFICATION_REASONS: readonly (readonly [string, string])[] = [
  ['EVM authorization challenge hash mismatch', 'wrong_nonce'],
  ['EVM authorization signature mismatch', 'invalid_signature'],
  ['EVM authorization is not valid yet', 'authorization_not_yet_valid'],
  ['EVM authorization has expired', 'authorization_expired'],
  ['EVM authorization source mismatch', 'source_mismatch'],
  ['EVM authorization amount mismatch', 'wrong_amount'],
  ['EVM authorization recipient mismatch', 'wrong_recipient'],
];

export function verificationReason(error: unknown): string {
  if (error instanceof Errors.PaymentExpiredError) return 'challenge_expired';
  if (error instanceof Errors.InvalidPayloadError) return 'invalid_payload';
  if (error instanceof Errors.InvalidChallengeError) return 'invalid_challenge';
  if (error instanceof Errors.VerificationFailedError) {
    const match = VERIFICATION_REASONS.find(([text]) => error.message.includes(text));
    if (match) return match[1];
  }
  return 'authorization_invalid';
}

// Accept the HTTP `Authorization: Payment ...` value or a JSON credential
// from MCP `_meta`. Serialize the object for mppx deserialization
export function decodeCredential(payload: string): Credential.Credential {
  const serialized = payload.trimStart().startsWith('{')
    ? Credential.serialize(JSON.parse(payload) as Credential.Credential)
    : payload;
  return Credential.deserialize(serialized);
}

// Compares the echoed challenge with the one issued for this request. Both
// carry a valid HMAC by now, so any difference means the credential answers a
// challenge issued for other terms. The final comparison catches a difference
// in any request field the named checks do not cover.
export function bindingMismatch(
  echoed: Challenge.Challenge,
  issued: Challenge.Challenge,
  resourceId: string,
): string | undefined {
  if (echoed.realm !== issued.realm) return 'wrong_realm';
  if (echoed.method !== issued.method || echoed.intent !== issued.intent) {
    return 'unsupported_method';
  }
  // Only the encoded `opaque` survives the credential round trip, not `meta`,
  // so compare it with the encoding of this resource's binding
  if (echoed.opaque !== PaymentRequest.serialize({ resource: resourceId })) {
    return 'wrong_resource';
  }
  // `issued` was built for the request carrying this credential, so a
  // different body, or none, fails here. A challenge without a digest binds
  // no body, as the core draft reads it.
  if (echoed.digest !== undefined && echoed.digest !== issued.digest) {
    return 'body_digest_mismatch';
  }
  const got = echoed.request as ChargeRequest;
  const want = issued.request as ChargeRequest;
  if (got.amount !== want.amount) return 'wrong_amount';
  if (!sameAddress(got.recipient, want.recipient)) return 'wrong_recipient';
  if (got.methodDetails?.chainId !== want.methodDetails?.chainId) return 'wrong_network';
  if (!sameAddress(got.currency, want.currency)) return 'wrong_asset';
  if (canonical(got.methodDetails) !== canonical(want.methodDetails)) {
    return 'unsupported_credential';
  }
  if (canonical(got) !== canonical(want)) return 'wrong_terms';
  return undefined;
}

// Rewrap the MPP authorization as the x402 `exact` payload expected by settlement
export function toX402Submission(
  x402Requirement: PaymentRequirement,
  authorization: Types.AuthorizationPayload,
): PaymentSubmission {
  const { signature, from, to, value, validAfter, validBefore, nonce } = authorization;
  const payment = {
    x402Version: 2,
    accepted: x402Requirement.challenge.accepts[0],
    payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } },
  };
  return { method: 'x402', payload: Buffer.from(JSON.stringify(payment)).toString('base64') };
}

interface ChargeRequest {
  readonly amount?: string;
  readonly currency?: string;
  readonly recipient?: string;
  readonly methodDetails?: { readonly chainId?: number };
}

// The encoding mppx binds into the challenge HMAC, so key order cannot
// produce a false mismatch
function canonical(value: object | undefined): string {
  return value === undefined ? '' : PaymentRequest.serialize(value as PaymentRequest.Request);
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && isAddress(a) && isAddress(b)
    ? getAddress(a) === getAddress(b)
    : false;
}
