/**
 * `PaymentResult.replayKey` is derived from the payment authorization alone,
 * never from the request id, so the same authorization replayed on another
 * request collides in the receipt store's reservation. The MPP provider uses
 * the EIP-3009 derivation.
 */
import { createHash } from 'node:crypto';
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

/**
 * Identifies a Solana `exact` payment by network and SHA-256 of the signed
 * message bytes. Excludes signatures, including the facilitator's fee payer
 * slot, so altered signatures keep the same key. `messageHash` is the SDK's
 * base64 `transactionMessageHash`.
 */
export function computeSvmReplayKey(input: {
  readonly network: string;
  readonly messageHash: string;
}): string {
  const digest = createHash('sha256')
    .update('x402/exact/svm/v1\0')
    .update(input.network)
    .update('\0')
    .update(Buffer.from(input.messageHash, 'base64'))
    .digest('hex');
  return `0x${digest}`;
}

/**
 * Identifies a NEAR `exact` payment by network, sender, curve-prefixed public
 * key (`ed25519:...`) and delegate nonce. Nonces are scoped per access key,
 * excluding token, recipient, relayer and signature; another key of the same
 * sender has an independent nonce scope.
 */
export function computeNearReplayKey(input: {
  readonly network: string;
  readonly senderId: string;
  readonly publicKey: string;
  readonly nonce: bigint;
}): string {
  const digest = createHash('sha256')
    .update('x402/exact/near/v1\0')
    .update(`${input.network}\0${input.senderId}\0${input.publicKey}\0${input.nonce.toString(10)}`)
    .digest('hex');
  return `0x${digest}`;
}
