/**
 * Builds offline NEAR `exact` payloads in the SDK client's format: one
 * `ft_transfer` in a NEP-366 delegate, signed with a real key and encoded as
 * base64 Borsh. Field overrides produce malformed and tampered test cases.
 */
import { KeyPair } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import {
  type Action,
  actionCreators,
  buildDelegateAction,
  encodeSignedDelegate,
} from '@near-js/transactions';

export interface DelegateOptions {
  readonly senderId?: string;
  /** The token contract the delegate calls */
  readonly receiverId?: string;
  readonly keyPair?: KeyPair;
  readonly methodName?: string;
  /** `ft_transfer` argument `receiver_id`, the payee */
  readonly ftReceiver?: string;
  readonly amount?: string;
  readonly deposit?: bigint;
  readonly gas?: bigint;
  readonly nonce?: bigint;
  readonly maxBlockHeight?: bigint;
  /** Replaces the single `ft_transfer` action */
  readonly actions?: Action[];
}

export const DELEGATE_DEFAULTS = {
  senderId: 'buyer.testnet',
  receiverId: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  ftReceiver: 'merchant.testnet',
  amount: '10000',
  nonce: 5n,
  maxBlockHeight: 1_060n,
  gas: 30_000_000_000_000n,
} as const;

/** The base64 Borsh signed delegate and the key that signed it */
export async function buildSignedDelegate(
  options: DelegateOptions = {},
): Promise<{ readonly signedDelegateAction: string; readonly keyPair: KeyPair }> {
  const keyPair = options.keyPair ?? KeyPair.fromRandom('ed25519');
  const actions = options.actions ?? [
    actionCreators.functionCall(
      options.methodName ?? 'ft_transfer',
      {
        receiver_id: options.ftReceiver ?? DELEGATE_DEFAULTS.ftReceiver,
        amount: options.amount ?? DELEGATE_DEFAULTS.amount,
      },
      options.gas ?? DELEGATE_DEFAULTS.gas,
      options.deposit ?? 1n,
    ),
  ];
  const delegateAction = buildDelegateAction({
    actions,
    maxBlockHeight: options.maxBlockHeight ?? DELEGATE_DEFAULTS.maxBlockHeight,
    nonce: options.nonce ?? DELEGATE_DEFAULTS.nonce,
    publicKey: keyPair.getPublicKey(),
    receiverId: options.receiverId ?? DELEGATE_DEFAULTS.receiverId,
    senderId: options.senderId ?? DELEGATE_DEFAULTS.senderId,
  });
  const [, signed] = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  return {
    signedDelegateAction: Buffer.from(encodeSignedDelegate(signed)).toString('base64'),
    keyPair,
  };
}
