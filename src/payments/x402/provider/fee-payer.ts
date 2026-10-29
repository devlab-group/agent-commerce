// Solana fee payers and NEAR relayers from the facilitator's `/supported`
import type { SupportedResponse } from '@x402/core/types';
import { CommerceError, type Logger } from '../../../core';
import { redactedErrorText } from '../../../core/errors';
import { normalizeAddress } from '../addresses';
import type { FacilitatorBinding } from '../facilitator';
import { X402_VERSION } from './constants';
import type { NearOffer, ProviderContext, SvmOffer } from './types';

// Cache lifetime for `/supported` responses shared by Solana and NEAR
const SUPPORTED_TTL_MS = 60_000;

export type SupportedSource = () => Promise<SupportedResponse>;

/** Creates a provider's shared `/supported` cache, refreshed on reads after expiry */
export function createSupportedSource(ctx: ProviderContext): SupportedSource {
  const { clock, remoteBinding } = ctx;
  let supportedSnapshot:
    | { readonly at: number; readonly response: Promise<SupportedResponse> }
    | undefined;

  function currentSupported(): Promise<SupportedResponse> {
    const now = clock.monotonicMs();
    if (supportedSnapshot && now - supportedSnapshot.at < SUPPORTED_TTL_MS) {
      return supportedSnapshot.response;
    }
    const remote = remoteBinding as Extract<FacilitatorBinding, { kind: 'remote' }>;
    const response = remote.supported();
    const snapshot = { at: now, response };
    supportedSnapshot = snapshot;
    // Discard failed requests so the next read retries
    response.catch(() => {
      if (supportedSnapshot === snapshot) supportedSnapshot = undefined;
    });
    return response;
  }

  return currentSupported;
}

/** Creates a Solana fee payer lookup for one provider */
export function createSvmFeePayerSource(
  currentSupported: SupportedSource,
): (offer: SvmOffer) => Promise<string> {
  // Keep each network's previous fee payer while `/supported` still lists it,
  // so refreshing the cache does not needlessly change challenge terms
  const feePayers = new Map<string, string>();

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

/**
 * Creates a lookup of NEAR relayer accounts for later transaction lookup.
 * A failed `/supported` read logs a warning and returns no relayers, allowing
 * an otherwise valid payment to verify.
 */
export function createNearRelayerSource(
  currentSupported: SupportedSource,
  logger: Logger,
): (offer: NearOffer) => Promise<readonly string[]> {
  return async (offer) => {
    let supported: SupportedResponse;
    try {
      supported = await currentSupported();
    } catch (err) {
      logger.warn(
        { err: redactedErrorText(err) },
        `x402 verify(): facilitator ${offer.binding.describe} did not answer /supported; the NEAR locator names no relayer`,
      );
      return [];
    }
    // Accept both network-specific and CAIP-family signer entries
    const { signers } = supported;
    return [...new Set([...(signers[offer.network] ?? []), ...(signers['near:*'] ?? [])])];
  };
}
