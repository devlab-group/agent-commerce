/**
 * CLIENT-SIDE payment helper.
 *
 * This module is used by the demo buyer agent (`demo/agent`) and by the
 * payment E2E test suite to build and EIP-712-sign an x402 `exact`/EVM
 * payment authorisation, entirely on the buyer's side.
 *
 * The gateway NEVER calls this module and NEVER holds a buyer private key.
 * `buyerPrivateKey` here is always an Anvil well-known
 * development key (LOCAL DEVELOPMENT ONLY — DO NOT FUND) supplied by whoever
 * is driving the demo/test, not something the provider or gateway manages.
 */

import { getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encodePayment } from 'x402/schemes';
import { getNetworkId } from 'x402/shared';
import { type PaymentPayload, PaymentRequirementsSchema } from 'x402/types';

export interface CreatePaymentProofOptions {
  /** Buyer's dev-only private key. LOCAL DEVELOPMENT ONLY — DO NOT FUND. */
  readonly buyerPrivateKey: `0x${string}`;
  readonly rpcUrl: string;
  /** One entry from PaymentRequiredEnvelope.payment.accepts, verbatim. */
  readonly accepts: Readonly<Record<string, unknown>>;
  /** Overrides used only by negative tests (wrong amount/recipient/nonce…). */
  readonly overrides?: {
    readonly value?: string;
    readonly payTo?: string;
    readonly nonce?: `0x${string}`;
    readonly validBefore?: number;
    readonly validAfter?: number;
  };
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const DEFAULT_VALID_AFTER_SKEW_SECONDS = 600; // 10 minutes in the past, matching x402's own client default.

/** Returns the base64 `X-PAYMENT` value to send back to the gateway. */
export async function createPaymentProof(options: CreatePaymentProofOptions): Promise<string> {
  const requirements = PaymentRequirementsSchema.parse(options.accepts);
  if (
    !requirements.extra ||
    typeof requirements.extra['name'] !== 'string' ||
    typeof requirements.extra['version'] !== 'string'
  ) {
    throw new Error(
      'createPaymentProof: payment requirement is missing extra.name/extra.version — cannot build the EIP-712 domain',
    );
  }

  const account = privateKeyToAccount(options.buyerPrivateKey);
  // `rpcUrl` is part of the frozen `CreatePaymentProofOptions` shape for
  // interface parity with other providers, but the `exact`/EVM scheme signs
  // fully offline: the chain id comes from the network name (matching what
  // the facilitator's `verify()`/`settle()` compute, and the
  // nonce is a fresh random value, not one read from chain state.
  void options.rpcUrl;
  const chainId = getNetworkId(requirements.network);

  const nonce = options.overrides?.nonce ?? randomNonce();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const validAfter = options.overrides?.validAfter ?? nowSeconds - DEFAULT_VALID_AFTER_SKEW_SECONDS;
  const validBefore = options.overrides?.validBefore ?? nowSeconds + requirements.maxTimeoutSeconds;
  const to = getAddress((options.overrides?.payTo ?? requirements.payTo) as `0x${string}`);
  const value = BigInt(options.overrides?.value ?? requirements.maxAmountRequired);

  const signature = await account.signTypedData({
    domain: {
      name: requirements.extra['name'],
      version: requirements.extra['version'],
      chainId,
      verifyingContract: getAddress(requirements.asset as `0x${string}`),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to,
      value,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  return encodePayment(payload);
}

function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
