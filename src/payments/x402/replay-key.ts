/**
 * `PaymentResult.replayKey` is derived from the payment authorization alone
 * (chain id, asset, payer, nonce), never from the request id, so the same
 * authorization replayed on another request collides in the receipt store's
 * reservation. The MPP provider uses the same derivation.
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
