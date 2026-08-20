/**
 * Replay-key derivation.
 *
 *Per docs/contracts.md, `PaymentResult.replayKey` MUST be
 * derived only from the payment authorisation (chain id, asset, payer,
 * nonce) — never from the request id — so that the same authorisation
 * replayed against a *different* request still collides in the gateway's
 * receipt-store reservation.
 */
import { encodeAbiParameters, keccak256 } from 'viem';

export interface ReplayKeyInput {
  readonly chainId: number;
  readonly asset: `0x${string}`;
  readonly from: `0x${string}`;
  readonly nonce: `0x${string}`;
}

export function computeReplayKey(input: ReplayKeyInput): string {
  const encoded = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
    [BigInt(input.chainId), input.asset, input.from, input.nonce],
  );
  return keccak256(encoded);
}
