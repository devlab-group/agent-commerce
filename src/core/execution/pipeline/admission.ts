// The payment phase: challenge, offer selection, verification, and the authorization and replay reservations

import type { PaymentMethodName } from '../../domain/common';
import type { PaymentProvider, PaymentRequirement, PaymentResult } from '../../domain/payment';
import type { CanonicalRequest, PaymentRequiredOutcome } from '../../domain/request';
import type { CommerceResource, Pricing } from '../../domain/resource';
import { CommerceError, isCommerceError, toCommerceError } from '../../errors';
import { REUSE_REJECTED_AUTHORIZATION_METADATA_KEY } from '../settlement-order';
import { type AuthorizeAndReserve, resolveAuthorizationProviders } from './authorization';
import { finishedReplay, retryChallenge } from './challenge';
import type { PipelineContext, SettleArgs } from './context';

/** A verified payment whose authorization and replay identity are reserved */
export interface AdmittedPayment {
  readonly kind: 'admitted';
  readonly settleArgs: SettleArgs;
}

export type AdmitPayment = (
  request: CanonicalRequest,
  resource: CommerceResource,
  pricing: Extract<Pricing, { type: 'fixed' }>,
  validInput: unknown,
) => Promise<PaymentRequiredOutcome | AdmittedPayment>;

/**
 * Builds the payment phase. It returns the challenge when the request carries
 * no proof, and otherwise verifies the proof and reserves the authorization
 * and replay identity, or throws.
 */
export function createPaymentAdmission(
  ctx: PipelineContext,
  authorizeAndReserve: AuthorizeAndReserve,
): AdmitPayment {
  const { options, safeEmit, buildEvent } = ctx;

  return async function admitPayment(request, resource, pricing, validInput) {
    const provider = pickProvider(options.paymentProviders, resource.paymentMethods);
    if (!provider) {
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `No enabled payment provider for resource "${resource.id}"`,
        {
          requestId: request.requestId,
          resourceId: resource.id,
          details: { paymentMethods: resource.paymentMethods },
        },
      );
    }

    // Resolved before the challenge so the 402 can name what the retry must
    // also carry, and so an uncheckable method fails before payment starts
    const authProviders = resolveAuthorizationProviders(
      options.authorizationProviders ?? [],
      resource,
      request.requestId,
    );

    let requirement: PaymentRequirement;
    try {
      requirement = await provider.createRequirement({
        requestId: request.requestId,
        resource,
        amount: pricing.amount,
        currency: pricing.currency,
        requestedAt: options.clock.nowIso(),
        // Transport facts a rail may bind into its challenge, such as a body digest
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      });
    } catch (error) {
      throw isCommerceError(error)
        ? error
        : new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider is unavailable', {
            requestId: request.requestId,
            resourceId: resource.id,
            cause: error,
          });
    }

    if (!request.payment) {
      await safeEmit(
        buildEvent({
          type: 'payment.required',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          paymentProvider: provider.name,
        }),
      );
      return {
        kind: 'payment-required',
        requestId: request.requestId,
        resourceId: resource.id,
        requirement,
        ...(authProviders.length > 0
          ? { authorization: authProviders.map((p) => p.requirement) }
          : {}),
      };
    }

    const payment = request.payment;

    let verification: PaymentResult;
    try {
      // Later steps, including authorization and settlement order, use the
      // selected requirement with its full retry challenge
      if (provider.selectRequirement) {
        requirement = await provider.selectRequirement({
          requestId: request.requestId,
          resource,
          requirement,
          submission: payment,
        });
      }
      verification = await provider.verify({
        requestId: request.requestId,
        resource,
        requirement,
        submission: payment,
      });
    } catch (error) {
      // A typed CommerceError is rethrown as is, keeping its code and its
      // possibly retryable status. Only an untyped throw is mapped, with a
      // fixed client-facing message.
      const mapped = isCommerceError(error)
        ? error
        : new CommerceError('PAYMENT_INVALID', 'Payment verification failed', {
            requestId: request.requestId,
            resourceId: resource.id,
            cause: error,
            ...retryChallenge(requirement),
          });
      await safeEmit(
        buildEvent({
          type: 'payment.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          paymentProvider: provider.name,
          status: 'error',
          data: { reason: mapped.code },
        }),
      );
      throw mapped;
    }

    if (verification.status !== 'verified') {
      await safeEmit(
        buildEvent({
          type: 'payment.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          paymentProvider: provider.name,
          status: 'error',
          data: verification.rejectionReason ? { reason: verification.rejectionReason } : {},
        }),
      );
      throw new CommerceError(
        'PAYMENT_INVALID',
        verification.rejectionReason ?? 'Payment was rejected',
        {
          requestId: request.requestId,
          resourceId: resource.id,
          ...retryChallenge(requirement, verification.rejectionReason),
        },
      );
    }

    if (!verification.replayKey) {
      await safeEmit(
        buildEvent({
          type: 'payment.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          paymentProvider: provider.name,
          status: 'error',
          data: { reason: 'missing-replay-key' },
        }),
      );
      throw new CommerceError('PAYMENT_INVALID', 'Payment provider did not return a replay key', {
        requestId: request.requestId,
        resourceId: resource.id,
      });
    }
    const replayKey = verification.replayKey;

    const hold = await authorizeAndReserve(
      request,
      resource,
      authProviders,
      requirement,
      validInput,
    );

    try {
      await options.store.reservePaymentAttempt({
        requestId: request.requestId,
        resourceId: resource.id,
        provider: provider.name,
        replayKey,
        amount: verification.amount,
        currency: verification.currency,
        ...(verification.payer !== undefined ? { payer: verification.payer } : {}),
        ...(verification.payee !== undefined ? { payee: verification.payee } : {}),
        ...(requirement.metadata?.[REUSE_REJECTED_AUTHORIZATION_METADATA_KEY] === true
          ? { reclaimRejected: true }
          : {}),
      });
    } catch (error) {
      // A duplicate replayKey arrives as PAYMENT_REPLAYED and is kept. Any
      // other failure (a full disk, a dropped connection) is STORAGE_ERROR,
      // never a replay.
      const mapped = toCommerceError(
        error,
        'STORAGE_ERROR',
        'Payment attempt could not be recorded',
      );
      await hold?.finalize('release');
      await safeEmit(
        buildEvent({
          type: 'payment.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          paymentProvider: provider.name,
          status: 'error',
          data: { reason: mapped.code },
        }),
      );
      throw finishedReplay(mapped, requirement);
    }

    await safeEmit(
      buildEvent({
        type: 'payment.verified',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
        paymentProvider: provider.name,
        status: 'ok',
      }),
    );

    return {
      kind: 'admitted',
      settleArgs: {
        request,
        resource,
        provider,
        requirement,
        payment,
        verification,
        replayKey,
        hold,
      },
    };
  };
}

function pickProvider(
  providers: readonly PaymentProvider[],
  methods: readonly PaymentMethodName[],
): PaymentProvider | undefined {
  for (const method of methods) {
    const found = providers.find((provider) => provider.name === method);
    if (found) return found;
  }
  return undefined;
}
