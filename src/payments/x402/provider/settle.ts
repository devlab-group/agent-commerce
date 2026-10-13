// Settles a verified proof and classifies the facilitator's answer
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { PaymentResult, PaymentSettlementContext } from '../../../core';
import { CommerceError } from '../../../core';
import { redactedErrorText } from '../../../core/errors';
import { isTransactionReference } from '../addresses';
import { decodePaymentSubmission, forFacilitator } from '../payload';
import { HEALTH_TIMEOUT_MS } from './constants';
import {
  isNearVerdict,
  isOnChainRevertError,
  isProviderUnavailableError,
  isTransactionFailedReason,
  NO_VERDICT_REASONS,
  ON_CHAIN_FAILURE_REASONS,
  SETTLEMENT_PENDING_REASON,
  sanitizeReason,
  UNKNOWN_OUTCOME_REASONS,
} from './reasons';
import { offerIndexOf } from './requirement';
import { readTransfer } from './transfer';
import type { ProviderContext } from './types';

/** Builds the provider's `settle`, which throws unless handed a successful verification */
export function createSettle(
  ctx: ProviderContext,
): (context: PaymentSettlementContext) => Promise<PaymentResult> {
  const { offersFor, clock, logger, nano } = ctx;

  async function settle(context: PaymentSettlementContext): Promise<PaymentResult> {
    const { requirement, submission, verification } = context;

    if (verification.status !== 'verified') {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'x402 provider: settle() called without a successful verify()',
      );
    }

    const index = offerIndexOf(requirement);
    const offer = index === undefined ? undefined : offersFor(requirement.resourceId)[index];
    const requirements =
      index === undefined
        ? undefined
        : (requirement.challenge.accepts[index] as PaymentRequirements | undefined);
    if (!offer || !requirements) {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'x402 provider: settle() found no payment requirements to settle against',
      );
    }

    const payload = decodePaymentSubmission(submission.payload);
    const transfer = payload && offer.family === 'evm' ? readTransfer(payload, offer) : undefined;
    if (!payload || typeof transfer === 'string') {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'x402 provider: settle() received an undecodable payment payload',
      );
    }
    const reference = (value: string) => isTransactionReference(offer.profile, value);

    const rejectedSettlement = (rejectionReason: string): PaymentResult => ({
      status: 'rejected',
      provider: 'x402',
      amount: verification.amount,
      currency: verification.currency,
      ...(verification.network !== undefined ? { network: verification.network } : {}),
      ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
      ...(verification.replayKey !== undefined ? { replayKey: verification.replayKey } : {}),
      rejectionReason,
    });

    // Nano: the buyer already sent the payment. Settling reads the block again
    // under the replay reservation the pipeline now holds; nothing is sent.
    if (offer.family === 'nano') {
      const nanoModule = await nano();
      const inspected = nanoModule.inspectNanoPayload(payload.payload, offer.network);
      if (typeof inspected === 'string') return rejectedSettlement(inspected);
      let sent: Awaited<ReturnType<typeof nanoModule.checkNanoSend>>;
      try {
        sent = await nanoModule.checkNanoSend(
          nanoModule.createNanoRpc(offer.rpcUrl, HEALTH_TIMEOUT_MS),
          {
            blockHash: inspected.blockHash,
            payTo: offer.payTo,
            amount: BigInt(requirements.amount),
          },
        );
      } catch (err) {
        // Nothing was submitted, so the attempt is released for a retry
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: the Nano node could not be read during settle()',
          {
            cause: err,
            details: { settlementNotSubmitted: true, reason: 'nano_rpc_unavailable' },
          },
        );
      }
      if (typeof sent === 'string') return rejectedSettlement(sent);
      return {
        status: 'settled',
        provider: 'x402',
        externalReference: inspected.blockHash,
        payer: sent.payer,
        payee: offer.payTo,
        amount: verification.amount,
        currency: verification.currency,
        network: offer.network,
        ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
        replayKey: inspected.replayKey,
        settledAt: clock.nowIso(),
        metadata: {
          // What the block sent, which may exceed the offer
          amountBaseUnits: sent.amount.toString(),
          ...(verification.currency !== requirement.currency
            ? { quote: { amount: requirement.amount, currency: requirement.currency } }
            : {}),
        },
      };
    }

    const scope = offer.binding.open();
    let sdkResult: SettleResponse;
    try {
      sdkResult = await scope.settle(forFacilitator(payload), requirements);
    } catch (err) {
      if (isProviderUnavailableError(err) || scope.transportFailed()) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          `x402 provider: ${offer.binding.kind} facilitator unreachable during settle()`,
          { cause: err },
        );
      }
      // The pinned SDK returns a result for every failure from gas estimation
      // on, so a throw comes from its checks before anything is sent. A revert
      // there is a real rejection, which releases any mandate the pipeline
      // holds for the purchase. Any other throw goes back as an unavailable
      // provider, which the pipeline records as `settlement-uncertain`, never
      // as a rejection blamed on the buyer.
      if (!isOnChainRevertError(err)) {
        logger.warn(
          { err: redactedErrorText(err) },
          'x402 settle(): settlement failed with an unclassified error; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement failed with an unclassified error; outcome unknown',
          { cause: err },
        );
      }
      logger.warn(
        { err: redactedErrorText(err), rejectionReason: 'transaction_reverted' },
        'x402 settle(): settlement transaction reverted on chain',
      );
      return rejectedSettlement('transaction_reverted');
    }

    // verify() established the payer. The Solana scheme's settlement example
    // names the fee payer there, while x402 v2 defines the payer's wallet.
    const payer = verification.payer ?? sdkResult.payer;

    if (!sdkResult.success) {
      // "Broadcast, never confirmed" is not "did not happen": the transfer may
      // be on-chain, so it throws as an unavailable provider carrying the hash,
      // and the pipeline records the attempt `settlement-uncertain`, not
      // `rejected`. The SDK's catch-all without a hash is treated the same way,
      // because its throw may have followed a broadcast and viem reports an
      // RPC error on the send as a revert.
      if (isTransactionFailedReason(sdkResult.errorReason) && !reference(sdkResult.transaction)) {
        // The appended message can carry an RPC URL
        logger.warn(
          { reportedReason: redactedErrorText(sdkResult.errorReason) },
          'x402 settle(): the broadcast failed without a transaction hash; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement failed with an unclassified error; outcome unknown',
        );
      }
      // These NEAR SDK checks fail before submission. Release the attempt so
      // a retry using the same access-key nonce can reserve it again.
      if (
        offer.family === 'near' &&
        NO_VERDICT_REASONS.has(sdkResult.errorReason ?? '') &&
        !sdkResult.transaction
      ) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: the facilitator could not check the payment before submitting it',
          {
            details: {
              settlementNotSubmitted: true,
              reason: sanitizeReason(sdkResult.errorReason, 'facilitator_unavailable'),
            },
          },
        );
      }
      // A broadcast the SDK could not confirm nor record for a retry comes
      // back as its catch-all with the transaction, and a message starting
      // `settlement_pending`
      if (
        sdkResult.errorReason === SETTLEMENT_PENDING_REASON ||
        sdkResult.errorMessage?.startsWith(SETTLEMENT_PENDING_REASON) === true ||
        UNKNOWN_OUTCOME_REASONS.has(sdkResult.errorReason ?? '') ||
        NO_VERDICT_REASONS.has(sdkResult.errorReason ?? '') ||
        scope.transportFailed()
      ) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement was broadcast but could not be confirmed',
          {
            ...(sdkResult.transaction
              ? { details: { transactionHash: sdkResult.transaction } }
              : {}),
          },
        );
      }
      // Only the family's on-chain failure proves a named transaction moved
      // nothing. Any other reason may follow a transfer that landed.
      if (
        sdkResult.transaction &&
        sdkResult.errorReason !== ON_CHAIN_FAILURE_REASONS[offer.family]
      ) {
        logger.warn(
          { reportedReason: redactedErrorText(sdkResult.errorReason ?? '') },
          'x402 settle(): the facilitator reported a failure with a transaction; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: the facilitator reported a failed settlement with a transaction; outcome unknown',
          { details: { transactionHash: sdkResult.transaction } },
        );
      }
      // A `settlement_failed` that reaches here carries its hash
      if (offer.family === 'near' && !isNearVerdict(sdkResult.errorReason)) {
        logger.warn(
          { reportedReason: redactedErrorText(sdkResult.errorReason ?? '') },
          'x402 settle(): NEAR facilitator failure reason is not a verdict; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement failed with an unclassified error; outcome unknown',
        );
      }
      if (sdkResult.errorReason !== undefined) {
        logger.debug(
          { reportedReason: redactedErrorText(sdkResult.errorReason) },
          'x402 settle(): facilitator failure reason',
        );
      }
      return {
        ...rejectedSettlement(sanitizeReason(sdkResult.errorReason, 'settlement_failed')),
        network: sdkResult.network,
        ...(payer !== undefined ? { payer } : {}),
        // The failed transaction, which the facilitator paid for
        ...(sdkResult.transaction ? { externalReference: sdkResult.transaction } : {}),
      };
    }

    // A success names the offer's network and a transaction in its family's
    // form; anything else unlocks nothing, and the outcome stays unknown
    if (!reference(sdkResult.transaction) || sdkResult.network !== offer.network) {
      logger.warn(
        { network: sdkResult.network },
        'x402 settle(): the facilitator reported a success it did not identify; outcome unknown',
      );
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'x402 provider: the facilitator reported a settlement without a valid transaction; outcome unknown',
      );
    }

    return {
      status: 'settled',
      provider: 'x402',
      externalReference: sdkResult.transaction,
      ...(payer !== undefined ? { payer } : {}),
      payee: requirements.payTo,
      amount: verification.amount,
      currency: verification.currency,
      network: sdkResult.network,
      ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
      ...(verification.replayKey !== undefined ? { replayKey: verification.replayKey } : {}),
      settledAt: clock.nowIso(),
      // `amount` is the display value; x402's settlement response reports base
      // units. verify() matched an EVM authorization's value to the offer.
      metadata: {
        amountBaseUnits: transfer?.value ?? requirements.amount,
        // The resource's own price, when it names a currency other than the token
        ...(verification.currency !== requirement.currency
          ? { quote: { amount: requirement.amount, currency: requirement.currency } }
          : {}),
      },
    };
  }

  return settle;
}
