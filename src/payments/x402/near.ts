/**
 * NEAR `exact` payload inspection with bounded decoding of the NEP-366 signed
 * delegate action, transfer checks, replay identity and reconciliation
 * coordinates. The provider loads this module, including its `@x402/near`
 * import, when a NEAR offer is configured.
 *
 * The facilitator checks the signature, the access key and its nonce, the
 * delegate window and chain state. The gateway checks the transfer the buyer
 * signed against the offer, so a proof for other terms never reaches it.
 */
import { decodeSignedDelegateB64, parseFtTransferArgs } from '@x402/near';
import { isRecord } from '../../core/is-record';
import { LOCATOR_VERSION } from './locator';
import { computeNearReplayKey } from './replay-key';

// One `ft_transfer` delegate is a few hundred bytes; this bounds the decoder
const MAX_SIGNED_DELEGATE_BASE64 = 4096;
// NEP-141 requires exactly one yoctoNEAR on `ft_transfer`
const ONE_YOCTO = 1n;

export interface NearTransferTerms {
  readonly network: string;
  /** The NEP-141 token contract the delegate must call */
  readonly asset: string;
  readonly payTo: string;
  /** Atomic units, as the offer states them */
  readonly amount: string;
}

/**
 * Returns the payer, replay key and locator for a NEAR `exact` payload that
 * matches the offer, or an SDK refusal reason. The provider adds relayers from
 * the facilitator's `/supported` response.
 */
export function inspectNearPayload(
  payload: unknown,
  terms: NearTransferTerms,
):
  | {
      readonly payer: string;
      readonly replayKey: string;
      readonly locator: Readonly<Record<string, unknown>>;
    }
  | string {
  const encoded = isRecord(payload) ? payload['signedDelegateAction'] : undefined;
  if (typeof encoded !== 'string' || encoded.length > MAX_SIGNED_DELEGATE_BASE64) {
    return 'invalid_exact_near_payload_shape';
  }
  let delegate: ReturnType<typeof decodeSignedDelegateB64>['delegate'];
  try {
    delegate = decodeSignedDelegateB64(encoded).delegate;
  } catch {
    return 'invalid_exact_near_payload_signed_delegate_action';
  }
  if (!isCanonical(encoded)) return 'invalid_exact_near_payload_signed_delegate_action';
  if (delegate.actionCount !== 1) return 'invalid_exact_near_payload_action_count';
  const call = delegate.functionCall;
  if (!call) return 'invalid_exact_near_payload_action_kind';
  if (call.methodName !== 'ft_transfer') return 'invalid_exact_near_payload_method_name';
  if (delegate.receiverId !== terms.asset) {
    return 'invalid_exact_near_payload_token_contract_mismatch';
  }
  let args: ReturnType<typeof parseFtTransferArgs>;
  try {
    args = parseFtTransferArgs(call.args);
  } catch {
    return 'invalid_exact_near_payload_ft_transfer_args';
  }
  if (args.receiver_id !== terms.payTo) return 'invalid_exact_near_payload_recipient_mismatch';
  if (args.amount !== terms.amount) return 'invalid_exact_near_payload_amount_mismatch';
  if (call.deposit !== ONE_YOCTO) return 'invalid_exact_near_payload_attached_deposit';
  return {
    payer: delegate.senderId,
    replayKey: computeNearReplayKey({
      network: terms.network,
      senderId: delegate.senderId,
      publicKey: delegate.publicKey,
      nonce: delegate.nonce,
    }),
    locator: {
      v: LOCATOR_VERSION,
      network: terms.network,
      senderId: delegate.senderId,
      publicKey: delegate.publicKey,
      nonce: delegate.nonce.toString(),
      maxBlockHeight: delegate.maxBlockHeight.toString(),
      asset: delegate.receiverId,
      receiver: args.receiver_id,
      amount: args.amount,
    },
  };
}

/**
 * One delegate, one encoding: canonical base64, and no bytes after the signed
 * delegate. The SDK decoder ignores such bytes, so the check decodes the
 * payload without its last byte: a canonical encoding then runs short.
 */
function isCanonical(encoded: string): boolean {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return false;
  try {
    decodeSignedDelegateB64(bytes.subarray(0, bytes.length - 1).toString('base64'));
    return false;
  } catch {
    return true;
  }
}
