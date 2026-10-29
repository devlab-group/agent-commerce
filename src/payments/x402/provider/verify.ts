// Checks a proof against the offer it pays, then asks the facilitator for a verdict
import type { PaymentRequired, PaymentRequirements, VerifyResponse } from '@x402/core/types';
import { formatUnits, getAddress } from 'viem';
import type { PaymentResult, PaymentVerificationContext } from '../../../core';
import { CommerceError, RECONCILIATION_METADATA_KEY } from '../../../core';
import { redactedErrorText } from '../../../core/errors';
import { normalizeAddress, sameAddress } from '../addresses';
import { declaredX402Version, decodePaymentSubmission, forFacilitator } from '../payload';
import { X402_VERSION } from './constants';
import { offerCurrency } from './offers';
import { isProviderUnavailableError, NO_VERDICT_REASONS, sanitizeReason } from './reasons';
import { acceptedMatchesOffer, offerIndexOf } from './requirement';
import { readTransfer, type Transfer } from './transfer';
import type { NearOffer, ProviderContext } from './types';

// Additional time to await optional NEAR relayers from `/supported` after
// a successful verification verdict
const RELAYER_GRACE_MS = 1_000;

/** Builds the provider's `verify`, which never moves funds */
export function createVerify(
  ctx: ProviderContext,
  nearRelayers: (offer: NearOffer) => Promise<readonly string[]>,
): (context: PaymentVerificationContext) => Promise<PaymentResult> {
  const { offersFor, clock, logger, svm, near } = ctx;

  /**
   * Checks a submission against the requirement this provider built, never
   * against `payload.accepted`, the copy the client echoes back. That copy
   * must itself match the offer, or the proof is refused.
   *
   * The `exact` scheme requires the authorized amount to match exactly,
   * including when the buyer offers more. Local refusals use x402 error codes
   * where available.
   */
  async function verify(context: PaymentVerificationContext): Promise<PaymentResult> {
    const { requirement, submission } = context;

    const rejected = (reason: string): PaymentResult => ({
      status: 'rejected',
      provider: 'x402',
      amount: requirement.amount,
      currency: requirement.currency,
      ...(requirement.network !== undefined ? { network: requirement.network } : {}),
      ...(requirement.asset !== undefined ? { asset: requirement.asset } : {}),
      rejectionReason: reason,
    });

    if (requirement.provider !== 'x402' || requirement.challenge.provider !== 'x402') {
      return rejected('wrong_provider');
    }

    // With several offers and none selected, the proof matched no single offer
    const index = offerIndexOf(requirement);
    if (index === undefined) {
      return rejected('invalid_payment_requirements');
    }
    const offer = offersFor(requirement.resourceId)[index];
    const requirements = requirement.challenge.accepts[index] as PaymentRequirements | undefined;
    if (!offer || !requirements) {
      return rejected('missing_payment_requirements');
    }

    // Defense in depth only: the pipeline builds a fresh requirement for every
    // request, so this rarely fires. The real expiry is the authorization's
    // own, which the facilitator checks.
    if (
      requirement.expiresAt !== undefined &&
      Date.parse(requirement.expiresAt) < clock.now().getTime()
    ) {
      return rejected('requirement_expired');
    }

    // This provider built the requirement, so the asset always matches in
    // normal operation. A corrupted one must still never authorize a transfer
    // of a different asset.
    if (!sameAddress(offer.profile, requirements.asset, offer.asset)) {
      return rejected('wrong_asset');
    }

    const payload = decodePaymentSubmission(submission.payload);
    if (!payload) {
      const version = declaredX402Version(submission.payload);
      return rejected(
        typeof version === 'number' && version !== X402_VERSION
          ? 'invalid_x402_version'
          : 'invalid_payload',
      );
    }
    if (payload.x402Version !== X402_VERSION) {
      return rejected('invalid_x402_version');
    }
    // EVM: the authorization names payer, payee and amount. Solana: the
    // facilitator reads the transaction, and the gateway takes its identity.
    // NEAR: the delegate names the transfer, checked here against the offer.
    let transfer: Transfer | undefined;
    let replayKey: string;
    let locator: Readonly<Record<string, unknown>>;
    let derivedPayer: string | undefined;
    if (offer.family === 'svm') {
      const inspected = (await svm()).inspectSvmPayload(payload.payload, offer.network);
      if (typeof inspected === 'string') return rejected(inspected);
      replayKey = inspected.replayKey;
      locator = inspected.locator;
    } else if (offer.family === 'near') {
      const inspected = (await near()).inspectNearPayload(payload.payload, {
        network: offer.network,
        asset: offer.asset,
        payTo: offer.payTo,
        amount: requirements.amount,
      });
      if (typeof inspected === 'string') return rejected(inspected);
      replayKey = inspected.replayKey;
      locator = inspected.locator;
      derivedPayer = inspected.payer;
    } else {
      const read = readTransfer(payload, offer);
      if (typeof read === 'string') return rejected(read);
      transfer = read;
      replayKey = read.replayKey;
      locator = read.locator;
      derivedPayer = read.from;
    }
    // Reject a different network before calling the facilitator. NEAR's
    // delegate signature itself does not bind the chain.
    if (payload.accepted.network !== offer.network) {
      return rejected('invalid_network');
    }
    // The signature omits flow and resource. Check the echoed offer;
    // `resource` is optional, but must match when present.
    const offeredUrl = (requirement.challenge.envelope as PaymentRequired | undefined)?.resource
      ?.url;
    if (
      !acceptedMatchesOffer(requirements, payload.accepted, offer.profile) ||
      (payload.resource !== undefined && payload.resource.url !== offeredUrl)
    ) {
      return rejected('invalid_payment_requirements');
    }
    let required: bigint;
    try {
      required = BigInt(requirements.amount);
    } catch {
      return rejected('invalid_payload');
    }
    if (transfer) {
      if (transfer.to !== getAddress(offer.payTo)) {
        return rejected(transfer.recipientMismatch);
      }
      let authorizedValue: bigint;
      try {
        authorizedValue = BigInt(transfer.value);
      } catch {
        return rejected('invalid_payload');
      }
      if (authorizedValue !== required) {
        return rejected(transfer.amountMismatch);
      }
    }

    // Fetch NEAR relayers alongside verification; failed `/supported` reads yield none
    const relayers = offer.family === 'near' ? nearRelayers(offer) : undefined;
    const scope = offer.binding.open();
    let sdkResult: VerifyResponse;
    try {
      sdkResult = await scope.verify(forFacilitator(payload), requirements);
    } catch (err) {
      // A throw means no verdict was obtained, so it is never held against the
      // buyer. Only an unclassified one is logged, as it may be an SDK fault.
      if (!isProviderUnavailableError(err) && !scope.transportFailed()) {
        logger.warn({ err: redactedErrorText(err) }, 'x402 verify(): unexpected SDK error');
      }
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `x402 provider: ${offer.binding.kind} facilitator returned no verdict during verify()`,
        { cause: err },
      );
    }

    if (!sdkResult.isValid) {
      // An RPC that never answered is not a payment that failed a check
      if (scope.transportFailed() || NO_VERDICT_REASONS.has(sdkResult.invalidReason ?? '')) {
        if (sdkResult.invalidReason !== undefined) {
          logger.debug(
            { reportedReason: redactedErrorText(sdkResult.invalidReason) },
            'x402 verify(): local facilitator transport failure reason',
          );
        }
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          `x402 provider: ${offer.binding.kind} facilitator unreachable during verify()`,
        );
      }
      // The raw reason is logged at debug level. Only what the buyer sees and
      // the ledger records is constrained.
      if (sdkResult.invalidReason !== undefined) {
        logger.debug(
          { reportedReason: redactedErrorText(sdkResult.invalidReason) },
          'x402 verify(): facilitator rejection reason',
        );
      }
      return rejected(sanitizeReason(sdkResult.invalidReason, 'invalid_payment'));
    }

    // The Solana payer is the facilitator's reading of the transaction
    const payer =
      derivedPayer ??
      (sdkResult.payer !== undefined && normalizeAddress(offer.profile, sdkResult.payer)
        ? sdkResult.payer
        : undefined);
    if (offer.family === 'svm' && payer !== undefined) locator = { ...locator, payer };
    const relayerIds = relayers !== undefined ? await withinGrace(relayers) : [];
    if (relayerIds.length > 0) locator = { ...locator, relayers: relayerIds };
    return {
      status: 'verified',
      provider: 'x402',
      ...(payer !== undefined ? { payer } : {}),
      payee: transfer?.to ?? offer.payTo,
      amount: formatUnits(required, offer.assetDecimals),
      currency: offerCurrency(offer, requirement.currency),
      network: payload.accepted.network,
      asset: offer.family === 'evm' ? getAddress(requirements.asset) : offer.asset,
      replayKey,
      metadata: { [RECONCILIATION_METADATA_KEY]: locator },
    };
  }

  return verify;

  async function withinGrace(relayers: Promise<readonly string[]>): Promise<readonly string[]> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), RELAYER_GRACE_MS);
      timer.unref();
    });
    const ids = await Promise.race([relayers, late]).finally(() => clearTimeout(timer));
    if (ids === undefined) {
      logger.warn(
        { graceMs: RELAYER_GRACE_MS },
        'x402 verify(): /supported is slow; the NEAR locator names no relayer',
      );
    }
    return ids ?? [];
  }
}
