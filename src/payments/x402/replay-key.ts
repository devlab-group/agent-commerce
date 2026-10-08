/**
 * `PaymentResult.replayKey` is derived from the payment authorization alone,
 * never from the request id, so the same authorization replayed on another
 * request collides in the receipt store's reservation. The MPP provider uses
 * the EIP-3009 derivation.
 */
import { PERMIT2_ADDRESS } from '@x402/evm';
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

/**
 * Identifies a Permit2 authorization by chain, Permit2 contract, owner and
 * nonce. Nonces span all tokens and spenders, so asset and resource are excluded.
 * The tag separates these keys from EIP-3009 in the receipt store's unique column.
 */
export function computePermit2ReplayKey(input: {
  readonly chainId: number;
  readonly owner: `0x${string}`;
  readonly nonce: string;
}): string {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        'x402/exact/permit2/v1',
        BigInt(input.chainId),
        PERMIT2_ADDRESS,
        input.owner,
        BigInt(input.nonce),
      ],
    ),
  );
}
