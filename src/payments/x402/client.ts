/**
 * CLIENT-SIDE payment helper.
 *
 * This module is used by the demo buyer agent (`demo/agent`) and by the
 * payment E2E test suite to build and EIP-712-sign an x402 v2 `exact`/EVM
 * payment authorisation, entirely on the buyer's side.
 *
 * The gateway NEVER calls this module and NEVER holds a buyer private key.
 * `buyerPrivateKey` here is always an Anvil well-known
 * development key (LOCAL DEVELOPMENT ONLY — DO NOT FUND) supplied by whoever
 * is driving the demo/test, not something the provider or gateway manages.
 *
 * It signs the EIP-712 authorisation directly rather than going through the
 * SDK's `x402Client`, for one reason: `overrides`. The negative payment tests
 * need authorisations that are deliberately wrong — wrong recipient, short
 * amount, reused nonce, expired window — and a conforming client will not
 * produce those. Interop with a real SDK client is proved separately, by a
 * test that pays the gateway using `x402Client` itself.
 */

import { PaymentRequirementsV2Schema } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainIdFromCaip2 } from './chain.js';

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

const X402_VERSION = 2;

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

/** Returns the base64 `PAYMENT-SIGNATURE` value to send back to the gateway. */
export async function createPaymentProof(options: CreatePaymentProofOptions): Promise<string> {
  const requirements = PaymentRequirementsV2Schema.parse(options.accepts);
  if (
    !requirements.extra ||
    typeof requirements.extra['name'] !== 'string' ||
    typeof requirements.extra['version'] !== 'string'
  ) {
    throw new Error(
      'createPaymentProof: payment requirement is missing extra.name/extra.version — cannot build the EIP-712 domain',
    );
  }

  const chainId = chainIdFromCaip2(requirements.network);
  if (chainId === undefined) {
    throw new Error(
      `createPaymentProof: network "${requirements.network}" is not a CAIP-2 eip155 identifier — cannot determine the chain id to sign against`,
    );
  }

  const account = privateKeyToAccount(options.buyerPrivateKey);
  // `rpcUrl` is part of the frozen `CreatePaymentProofOptions` shape for
  // interface parity with other providers, but the `exact`/EVM scheme signs
  // fully offline: the chain id comes from the CAIP-2 network identifier
  // (matching what the facilitator's verify()/settle() compute), and the
  // nonce is a fresh random value, not one read from chain state.
  void options.rpcUrl;

  const nonce = options.overrides?.nonce ?? randomNonce();
  const nowSeconds = Math.floor(Date.now() / 1000);
  // 0, matching the SDK's own v2 client: `validAfter` exists to delay an
  // authorisation, and nothing here wants one delayed. A backdated value would
  // only paper over clock skew that `validBefore` has to tolerate anyway.
  const validAfter = options.overrides?.validAfter ?? 0;
  const validBefore = options.overrides?.validBefore ?? nowSeconds + requirements.maxTimeoutSeconds;
  const to = getAddress((options.overrides?.payTo ?? requirements.payTo) as `0x${string}`);
  const value = BigInt(options.overrides?.value ?? requirements.amount);

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

  // v2 carries the selected requirement back to the server as `accepted`
  // rather than repeating scheme/network at the top level. The server treats
  // that echo as untrusted and verifies against its own copy; it is on the
  // wire so a stateless facilitator knows which offer was taken.
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    accepted: requirements as PaymentRequirements,
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

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
