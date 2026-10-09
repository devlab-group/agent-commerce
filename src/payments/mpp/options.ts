// The MPP provider's options, checked once at construction
import { isAddress } from 'viem';
import { type Clock, CommerceError, type IdGenerator, type Logger } from '../../core';
import type { X402FacilitatorConfig } from '../x402/guardrails';
import type { X402PaymentFlow } from '../x402/payment-flow';
import { isMppNetwork, MPP_MIN_CHALLENGE_SECRET_LENGTH, MPP_NETWORKS } from './constants';

/** Whether the token contract has recorded `nonce` as used by `payer` */
export type NonceUsedReader = (payer: `0x${string}`, nonce: `0x${string}`) => Promise<boolean>;

export interface MppProviderOptions {
  /** Merchant-controlled settlement destination. Never gateway-owned */
  readonly recipient: `0x${string}`;
  /** EIP-3009 token the charge is paid in */
  readonly asset: `0x${string}`;
  /** EIP-712 domain name of the asset, e.g. 'USDC' or 'MockUSDC' */
  readonly assetName: string;
  /** EIP-712 domain version of the asset, e.g. '2' */
  readonly assetVersion: string;
  /** Value of each challenge's `realm`, such as the gateway's host */
  readonly realm: string;
  /** Key that binds each challenge to this gateway. Never logged or published */
  readonly challengeSecret: string;
  /** RPC endpoint of the settlement chain */
  readonly rpcUrl: string;
  /** The x402 facilitator that verifies and broadcasts the authorization */
  readonly facilitator: X402FacilitatorConfig;
  /** Must be `true` before anything settles on a mainnet. Never a default */
  readonly allowMainnet?: boolean;
  /** Required on mainnet when facilitator auth is `none` */
  readonly allowUnauthenticatedFacilitator?: boolean;
  readonly logger?: Logger;
  /**
   * Seconds a challenge stays valid, 300 by default. The mppx client signs its
   * authorization to expire at the same moment.
   */
  readonly challengeTtlSeconds?: number;
  /**
   * CAIP-2 network: `eip155:31337` (local Anvil), `eip155:84532` (Base
   * Sepolia, the default) or `eip155:8453` (Base)
   */
  readonly network?: string;
  /**
   * Same flow values as x402. The default, `upfront`, settles before the
   * backend; `authorization` settles after it
   */
  readonly paymentFlow?: X402PaymentFlow;
  /** Per-resource overrides of `paymentFlow`, keyed by resource id */
  readonly resourcePaymentFlows?: Readonly<Record<string, X402PaymentFlow>>;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export function configInvalid(message: string): CommerceError {
  return new CommerceError('CONFIG_INVALID', message);
}

export type MppChallengeOptions = Omit<
  MppProviderOptions,
  'rpcUrl' | 'facilitator' | 'allowMainnet' | 'allowUnauthenticatedFacilitator' | 'logger'
>;

export function validateOptions(options: MppChallengeOptions): void {
  if (!isAddress(options.recipient)) throw configInvalid('MPP recipient is not an EVM address');
  if (!isAddress(options.asset)) throw configInvalid('MPP asset is not an EVM address');
  if (options.assetName.length === 0 || options.assetVersion.length === 0) {
    throw configInvalid('MPP asset needs its EIP-712 domain name and version');
  }
  // mppx refuses CR or LF in the quoted realm parameter, so checking here fails
  // at construction instead of on every challenge
  if (options.realm.length === 0 || /[\r\n]/.test(options.realm)) {
    throw configInvalid('MPP realm must be a non-empty single-line string');
  }
  if (options.challengeSecret.length < MPP_MIN_CHALLENGE_SECRET_LENGTH) {
    throw configInvalid(
      `MPP challenge secret must have length at least ${MPP_MIN_CHALLENGE_SECRET_LENGTH}`,
    );
  }
  const ttl = options.challengeTtlSeconds;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) {
    throw configInvalid('MPP challenge TTL must be a positive whole number of seconds');
  }
  if (options.network !== undefined && !isMppNetwork(options.network)) {
    throw configInvalid(`MPP network must be one of ${MPP_NETWORKS.join(', ')}`);
  }
}
