/**
 * Client-side payment helper: builds and EIP-712-signs an x402 v2 `exact`/EVM
 * authorization on the buyer's side. The demo buyer agent and the test suites
 * use it, and the `/x402` entry exports it. The gateway never calls it and
 * never holds a buyer key.
 *
 * It signs directly rather than through the SDK's `x402Client` because of
 * `overrides`: negative tests need deliberately wrong authorizations that a
 * conforming client will not produce. The x402 settlement E2E suite also
 * settles a payment built by `x402Client` itself to cover interoperability.
 */

import { PaymentRequirementsV2Schema } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CommerceError } from '../../core';
import { chainIdFromCaip2 } from './chain';

export interface CreatePaymentProofOptions {
  /** The buyer's private key. It signs locally and is never sent anywhere */
  readonly buyerPrivateKey: `0x${string}`;
  /** One entry from PaymentRequiredEnvelope.payment.accepts, verbatim */
  readonly accepts: Readonly<Record<string, unknown>>;
  /** For negative tests only: a wrong amount, recipient, nonce or validity window */
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

/** Returns the base64 `PAYMENT-SIGNATURE` value to send back to the gateway */
export async function createPaymentProof(options: CreatePaymentProofOptions): Promise<string> {
  const requirements = PaymentRequirementsV2Schema.parse(options.accepts);
  if (
    !requirements.extra ||
    typeof requirements.extra['name'] !== 'string' ||
    typeof requirements.extra['version'] !== 'string'
  ) {
    throw new CommerceError(
      'INPUT_INVALID',
      'createPaymentProof: payment requirement is missing extra.name/extra.version, so the EIP-712 domain cannot be built',
    );
  }

  const chainId = chainIdFromCaip2(requirements.network);
  if (chainId === undefined) {
    throw new CommerceError(
      'INPUT_INVALID',
      `createPaymentProof: network "${requirements.network}" is not a CAIP-2 eip155 identifier, so there is no chain id to sign against`,
    );
  }

  const account = privateKeyToAccount(options.buyerPrivateKey);

  const nonce = options.overrides?.nonce ?? randomNonce();
  const nowSeconds = Math.floor(Date.now() / 1000);
  // 0, as in the SDK's own v2 client: nothing here wants the authorization
  // delayed
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

  // v2 echoes the chosen requirement back as `accepted` so a stateless
  // facilitator knows which offer was taken. The gateway verifies against its
  // own copy.
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
