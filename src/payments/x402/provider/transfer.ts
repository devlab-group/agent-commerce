// What an EVM payload authorizes: payer, payee, amount and replay key

import type { PaymentPayload } from '@x402/core/types';
import { x402ExactPermit2ProxyAddress } from '@x402/evm';
import { getAddress, isAddress } from 'viem';
import { hasEip3009Fields, isExactEvmPayload, isExactPermit2Payload } from '../payload';
import { computePermit2ReplayKey, computeReplayKey } from '../replay-key';
import type { EvmOffer } from './types';

// What a payload authorizes, read the way the offer's method settles it
export interface Transfer {
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly value: string;
  readonly replayKey: string;
  readonly recipientMismatch: string;
  readonly amountMismatch: string;
}

/**
 * Reads the payer, payee, amount and replay key, or returns a refusal reason.
 * Enforces the offer's method because the SDK facilitator chooses the method
 * from the payload.
 */
export function readTransfer(payload: PaymentPayload, offer: EvmOffer): Transfer | string {
  // verify() refuses an `accepted.network` other than the offer's, so this
  // chain id is the one the authorization is bound to
  const { chainId } = offer.profile;
  if (offer.method === 'eip3009') {
    if (!isExactEvmPayload(payload)) return 'unsupported_scheme';
    const { authorization } = payload.payload;
    const { from, to, value, nonce } = authorization;
    if (!hasEip3009Fields(authorization) || !isAddress(from) || !isAddress(to)) {
      return 'invalid_payload';
    }
    return {
      from: getAddress(from),
      to: getAddress(to),
      value,
      replayKey: computeReplayKey({
        chainId,
        asset: getAddress(offer.asset),
        from: getAddress(from),
        nonce,
      }),
      recipientMismatch: 'invalid_exact_evm_payload_recipient_mismatch',
      amountMismatch: 'invalid_exact_evm_payload_authorization_value_mismatch',
    };
  }
  if (!isExactPermit2Payload(payload)) return 'unsupported_scheme';
  const { from, spender, permitted, witness, nonce } = payload.payload.permit2Authorization;
  // Permit2 lets the spender move the permitted tokens anywhere; only the x402
  // proxy binds the transfer to the signed witness recipient
  if (getAddress(spender) !== getAddress(x402ExactPermit2ProxyAddress)) {
    return 'invalid_permit2_spender';
  }
  if (getAddress(permitted.token) !== getAddress(offer.asset)) return 'permit2_token_mismatch';
  return {
    from: getAddress(from),
    to: getAddress(witness.to),
    value: permitted.amount,
    replayKey: computePermit2ReplayKey({ chainId, owner: getAddress(from), nonce }),
    recipientMismatch: 'invalid_permit2_recipient_mismatch',
    amountMismatch: 'permit2_amount_mismatch',
  };
}
