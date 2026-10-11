// The Solana fee payer an offer names, read from the facilitator's `/supported`
import type { SupportedResponse } from '@x402/core/types';
import { CommerceError } from '../../../core';
import { normalizeAddress } from '../addresses';
import type { FacilitatorBinding } from '../facilitator';
import { X402_VERSION } from './constants';
import type { ProviderContext, SvmOffer } from './types';

// How long a `/supported` snapshot names the Solana fee payer of new offers
const SUPPORTED_TTL_MS = 60_000;

/** Returns the fee payer lookup, with its `/supported` snapshot, for one provider */
export function createSvmFeePayerSource(
  ctx: ProviderContext,
): (offer: SvmOffer) => Promise<string> {
  const { clock, remoteBinding } = ctx;

  // A Solana offer carries the fee payer the facilitator names in `/supported`.
  // A snapshot lasts SUPPORTED_TTL_MS, and a refresh keeps the previous fee
  // payer while the facilitator still lists it, so a challenge and the retry
  // that pays it agree.
  let supportedSnapshot:
    | { readonly at: number; readonly response: Promise<SupportedResponse> }
    | undefined;
  const feePayers = new Map<string, string>();

  function currentSupported(): Promise<SupportedResponse> {
    const now = clock.monotonicMs();
    if (supportedSnapshot && now - supportedSnapshot.at < SUPPORTED_TTL_MS) {
      return supportedSnapshot.response;
    }
    const remote = remoteBinding as Extract<FacilitatorBinding, { kind: 'remote' }>;
    const response = remote.supported();
    const snapshot = { at: now, response };
    supportedSnapshot = snapshot;
    // A failed fetch is not kept; the next challenge asks again
    response.catch(() => {
      if (supportedSnapshot === snapshot) supportedSnapshot = undefined;
    });
    return response;
  }

  async function svmFeePayer(offer: SvmOffer): Promise<string> {
    let supported: SupportedResponse;
    try {
      supported = await currentSupported();
    } catch (cause) {
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `x402 provider: facilitator ${offer.binding.describe} did not answer /supported, which names the Solana fee payer`,
        { cause },
      );
    }
    const listed = supported.kinds.find(
      (kind) =>
        kind.x402Version === X402_VERSION &&
        kind.scheme === 'exact' &&
        kind.network === offer.network,
    )?.extra?.['feePayer'];
    const previous = feePayers.get(offer.network);
    const stillSigns =
      previous !== undefined &&
      (previous === listed || Object.values(supported.signers).some((s) => s.includes(previous)));
    const feePayer = stillSigns ? previous : listed;
    if (typeof feePayer !== 'string' || normalizeAddress(offer.profile, feePayer) === undefined) {
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `x402 provider: facilitator ${offer.binding.describe} names no Solana fee payer for ${offer.network}`,
      );
    }
    feePayers.set(offer.network, feePayer);
    return feePayer;
  }

  return svmFeePayer;
}
