// Settles a verified, reserved payment, or records that the backend failed before it could
import type { PaymentRequirement, PaymentResult } from '../../domain/payment';
import { CommerceError, isCommerceError } from '../../errors';
import { retryChallenge } from './challenge';
import type { PipelineContext, SettleArgs } from './context';

export interface Settlement {
  /** Settles and finalizes the authorization; a refusal or unknown outcome throws */
  readonly settle: (args: SettleArgs) => Promise<PaymentResult>;
  /** Records a backend failure before settlement and releases the authorization */
  readonly abandonSettlement: (args: SettleArgs, backendErrorCode: string) => Promise<void>;
}

export function createSettlement(ctx: PipelineContext): Settlement {
  const { options, safeEmit, safePersist, buildEvent } = ctx;

  // Settle a verified, reserved payment and finalize its authorization.
  // Rejected or uncertain settlement throws before any response is delivered.
  async function settle(args: SettleArgs): Promise<PaymentResult> {
    const { request, resource, provider, requirement, payment, verification, replayKey, hold } =
      args;
    let settlement: PaymentResult;
    try {
      settlement = await provider.settle({
        requestId: request.requestId,
        resource,
        requirement,
        submission: payment,
        verification,
      });
    } catch (error) {
      // A throw gives no settlement verdict. The facilitator may have
      // broadcast before losing its response, even without a transaction
      // hash. Keep the authorization uncertain so it cannot be spent again.
      const txHash = settlementTxHash(error);
      await hold?.finalize('markUncertain');
      await safePersist(
        () =>
          options.store.updatePaymentAttempt({
            replayKey,
            status: 'settlement-uncertain',
            ...(txHash !== undefined ? { externalReference: txHash } : {}),
            ...(error instanceof Error ? { rejectionReason: error.message } : {}),
          }),
        'updatePaymentAttempt(settlement-uncertain)',
        request.requestId,
      );
      await safeEmit(
        buildEvent({
          type: 'payment.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          paymentProvider: provider.name,
          status: 'error',
          data: {
            reason: 'settlement-uncertain',
            ...(txHash !== undefined ? { transactionHash: txHash } : {}),
          },
        }),
      );
      // The replay key remains reserved, so report an uncertain, non-retryable
      // outcome. Expose only the transaction hash from the underlying error.
      throw new CommerceError('PAYMENT_SETTLEMENT_FAILED', 'Settlement could not be confirmed', {
        requestId: request.requestId,
        resourceId: resource.id,
        cause: error,
        details: {
          settlementUncertain: true,
          ...(txHash !== undefined ? { transactionHash: txHash } : {}),
          ...settlementParties(requirement, verification),
        },
      });
    }

    if (settlement.status !== 'settled') {
      await hold?.finalize('release');
      await safePersist(
        () =>
          options.store.updatePaymentAttempt({
            replayKey,
            status: 'rejected',
            ...(settlement.rejectionReason !== undefined
              ? { rejectionReason: settlement.rejectionReason }
              : {}),
          }),
        'updatePaymentAttempt(rejected)',
        request.requestId,
      );
      await safeEmit(
        buildEvent({
          type: 'payment.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          paymentProvider: provider.name,
          status: 'error',
          data: settlement.rejectionReason ? { reason: settlement.rejectionReason } : {},
        }),
      );
      // A returned rejection confirms no settlement. Both rails return 402.
      const rejectionDetails = retryChallenge(requirement, settlement.rejectionReason).details;
      throw new CommerceError(
        'PAYMENT_SETTLEMENT_FAILED',
        settlement.rejectionReason ?? 'Settlement was rejected',
        {
          requestId: request.requestId,
          resourceId: resource.id,
          httpStatus: 402,
          details: {
            ...rejectionDetails,
            ...settlementParties(requirement, settlement, verification),
          },
        },
      );
    }

    await hold?.finalize('consume');
    await safePersist(
      () =>
        options.store.updatePaymentAttempt({
          replayKey,
          status: 'settled',
          ...(settlement.externalReference !== undefined
            ? { externalReference: settlement.externalReference }
            : {}),
        }),
      'updatePaymentAttempt(settled)',
      request.requestId,
    );
    await safeEmit(
      buildEvent({
        type: 'payment.settled',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
        paymentProvider: provider.name,
        status: 'ok',
      }),
    );

    return settlement;
  }

  // Record the pre-settlement backend failure and release the authorization
  // hold. Rails with reuse metadata can reserve the unspent replay key again,
  // as after any rejection.
  async function abandonSettlement(args: SettleArgs, backendErrorCode: string): Promise<void> {
    const { request, resource, provider, replayKey, hold } = args;
    await hold?.finalize('release');
    await safePersist(
      () =>
        options.store.updatePaymentAttempt({
          replayKey,
          status: 'rejected',
          rejectionReason: 'backend_failed',
        }),
      'updatePaymentAttempt(backend-failed)',
      request.requestId,
    );
    await safeEmit(
      buildEvent({
        type: 'payment.rejected',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
        paymentProvider: provider.name,
        status: 'error',
        data: { reason: 'backend-failed', backendErrorCode },
      }),
    );
  }

  return { settle, abandonSettlement };
}

// The broadcast transaction hash a provider attached to a settlement throw,
// when it knows one
function settlementTxHash(error: unknown): string | undefined {
  const hash = isCommerceError(error) ? error.details?.['transactionHash'] : undefined;
  return typeof hash === 'string' ? hash : undefined;
}

// Prefer the network and payer reported by settlement or verification, then
// fall back to the requirement's network
function settlementParties(
  requirement: PaymentRequirement,
  ...results: readonly PaymentResult[]
): { network?: string; payer?: string } {
  const network = results.find((r) => r.network !== undefined)?.network ?? requirement.network;
  const payer = results.find((r) => r.payer !== undefined)?.payer;
  return {
    ...(network !== undefined ? { network } : {}),
    ...(payer !== undefined ? { payer } : {}),
  };
}
