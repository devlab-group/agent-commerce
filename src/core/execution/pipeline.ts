/**
 * The single execution path every protocol adapter converges on. The order is a
 * security boundary; do not reorder:
 *
 * 1. resolve resource (RESOURCE_NOT_FOUND)
 * 2. strip reserved input fields, validate input and the backend request shape
 *    (INPUT_INVALID, or BACKEND_ERROR for an illegal configured header)
 * 3. resolve price
 * 4. free: straight to the backend
 * 5. paid: pick provider and createRequirement, then return a challenge or
 *    verify the proof and reserve authorization and replay identities
 * 6. settle before calling the backend, or call the backend first and settle
 *    only if it succeeds. Finalize authorization according to the outcome
 *    (BACKEND_TIMEOUT / BACKEND_ERROR)
 * 7. persist receipt, emit events, return outcome
 */

import type {
  AuthorizationProvider,
  AuthorizationRecord,
  AuthorizationVerification,
} from '../domain/authorization';
import type { AuthorizationMethodName, PaymentMethodName } from '../domain/common';
import type { CommerceEvent, EventSink } from '../domain/event';
import type {
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSubmission,
} from '../domain/payment';
import type { CommerceReceipt } from '../domain/receipt';
import type { CanonicalRequest, ExecutionOutcome, ExecutionPipeline } from '../domain/request';
import type { CommerceResource, ResourceRegistry } from '../domain/resource';
import { RESERVED_INPUT_FIELDS } from '../domain/wire';
import { CommerceError, describeError, isCommerceError, toCommerceError } from '../errors';
import type { BackendExecutor, BackendResponse } from '../interfaces/backend';
import type { Logger } from '../interfaces/logger';
import type { Clock, IdGenerator } from '../interfaces/runtime';
import type { ReceiptStore } from '../interfaces/store';
import { isRecord } from '../is-record';
import { validateBackendRequestShape } from './backend-http';
import { SETTLE_AFTER_BACKEND_METADATA_KEY } from './settlement-order';
import { compileJsonSchema, type Validator } from './validation';

export interface CreateExecutionPipelineOptions {
  readonly resources: ResourceRegistry;
  readonly paymentProviders: readonly PaymentProvider[];
  /** Defaults to none */
  readonly authorizationProviders?: readonly AuthorizationProvider[];
  readonly store: ReceiptStore;
  readonly backend: BackendExecutor;
  readonly events: EventSink;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

// A reservation held across settlement, plus the summary the receipt keeps.
// `finalize` ends it.
interface AuthorizationHold {
  readonly record: AuthorizationRecord;
  finalize(action: 'consume' | 'release' | 'markUncertain'): Promise<void>;
}

export function createExecutionPipeline(
  options: CreateExecutionPipelineOptions,
): ExecutionPipeline {
  const validators = new Map<string, Validator>();

  function getValidator(resource: CommerceResource): Validator {
    const cached = validators.get(resource.id);
    if (cached) return cached;
    const compiled = compileJsonSchema(resource.inputSchema);
    validators.set(resource.id, compiled);
    return compiled;
  }

  async function safeEmit(event: CommerceEvent): Promise<void> {
    try {
      await options.events.emit(event);
    } catch (error) {
      options.logger.error(
        { err: describeError(error), eventType: event.type, requestId: event.requestId },
        'Event sink failed; commerce flow continues',
      );
    }
  }

  async function safePersist(
    op: () => Promise<void>,
    label: string,
    requestId: string,
  ): Promise<void> {
    try {
      await op();
    } catch (error) {
      options.logger.error(
        { err: describeError(error), requestId },
        `Persistence failed: ${label}`,
      );
    }
  }

  function buildEvent(partial: Omit<CommerceEvent, 'id' | 'at'>): CommerceEvent {
    return { id: options.ids.next('evt'), at: options.clock.nowIso(), ...partial };
  }

  // Verify and reserve what the resource requires, or undefined if it requires
  // none. Runs after payment verification, which has no side effect, so a bad
  // payment proof cannot burn a reservation.
  async function authorizeAndReserve(
    request: CanonicalRequest,
    resource: CommerceResource,
    providers: readonly AuthorizationProvider[],
    requirement: PaymentRequirement,
    input: unknown,
  ): Promise<AuthorizationHold | undefined> {
    if (providers.length === 0) return undefined;

    const submission = request.authorization;
    const provider = providers.find((candidate) => candidate.name === submission?.method);
    // A request carries one proof, so a resource requiring two methods is
    // refused here rather than half-checked
    const unmet = providers.filter((candidate) => candidate !== provider).map((c) => c.name);

    if (submission === undefined || provider === undefined || unmet.length > 0) {
      await safeEmit(
        buildEvent({
          type: 'authorization.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          status: 'error',
          data: { reason: 'AUTHORIZATION_REQUIRED', methods: unmet },
        }),
      );
      throw new CommerceError(
        'AUTHORIZATION_REQUIRED',
        `Resource "${resource.id}" requires authorization: ${unmet.join(', ')}`,
        {
          requestId: request.requestId,
          resourceId: resource.id,
          details: { required: providers.map((candidate) => candidate.name), missing: unmet },
        },
      );
    }

    let verification: AuthorizationVerification;
    try {
      verification = await provider.verifyAndReserve({
        requestId: request.requestId,
        resourceId: resource.id,
        input,
        submission,
        requirement,
      });
    } catch (error) {
      // An untyped throw says nothing about whose fault it was. Unavailable is
      // honest and retryable; invalid would blame the buyer for our outage.
      const mapped = isCommerceError(error)
        ? error
        : new CommerceError(
            'AUTHORIZATION_PROVIDER_UNAVAILABLE',
            'Authorization provider is unavailable',
            {
              requestId: request.requestId,
              resourceId: resource.id,
              cause: error,
            },
          );
      await safeEmit(
        buildEvent({
          type: 'authorization.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          status: 'error',
          data: { reason: mapped.code, method: provider.name },
        }),
      );
      throw mapped;
    }

    await safeEmit(
      buildEvent({
        type: 'authorization.verified',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
        status: 'ok',
        data: { method: verification.method, reference: verification.reference },
      }),
    );

    const context = { requestId: request.requestId, resourceId: resource.id };
    return {
      record: {
        method: verification.method,
        reference: verification.reference,
        ...(verification.metadata !== undefined ? { metadata: verification.metadata } : {}),
      },
      async finalize(action) {
        try {
          await provider[action](verification.reservationId, context);
        } catch (error) {
          // A failure leaves the reservation reserved, which is still
          // unspendable, so the caller's outcome stands
          options.logger.error(
            { err: describeError(error), requestId: request.requestId, action },
            'Authorization finalization failed; the reservation stays reserved',
          );
        }
      },
    };
  }

  interface SettleArgs {
    readonly request: CanonicalRequest;
    readonly resource: CommerceResource;
    readonly provider: PaymentProvider;
    readonly requirement: PaymentRequirement;
    readonly payment: PaymentSubmission;
    readonly verification: PaymentResult;
    readonly replayKey: string;
    readonly hold: AuthorizationHold | undefined;
  }

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

  // The backend failed before settlement. Keep the payment replay key,
  // record rejection, and release the separate authorization hold.
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

  async function execute(request: CanonicalRequest): Promise<ExecutionOutcome> {
    const pipelineStart = options.clock.monotonicMs();

    // 1. resolve resource
    const resource = options.resources.get(request.resourceId);
    // Same code and message as an unknown id: a caller on a protocol the
    // resource is not exposed via must not learn that it exists
    if (!resource?.exposedVia.includes(request.protocol)) {
      throw new CommerceError(
        'RESOURCE_NOT_FOUND',
        `Resource "${request.resourceId}" was not found`,
        {
          requestId: request.requestId,
          resourceId: request.resourceId,
        },
      );
    }

    await safeEmit(
      buildEvent({
        type: 'resource.requested',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
      }),
    );

    // 2. strip reserved gateway fields, then validate input
    const strippedInput = stripReservedFields(request.input);
    const validation = getValidator(resource)(strippedInput);
    if (!validation.valid) {
      throw new CommerceError(
        'INPUT_INVALID',
        `Input for resource "${resource.id}" failed validation`,
        {
          requestId: request.requestId,
          resourceId: resource.id,
          details: { errors: validation.errors },
        },
      );
    }
    const validInput = validation.value;

    // Before pricing, so a request the backend cannot receive fails before
    // payment (see validateBackendRequestShape)
    validateBackendRequestShape(resource.handler, validInput, {
      requestId: request.requestId,
      resourceId: resource.id,
    });

    // 3. resolve price
    if (resource.pricing.type === 'dynamic') {
      // Config validation rejects this at load; this is defense in depth
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${resource.id}" uses unsupported dynamic pricing`,
        {
          requestId: request.requestId,
          resourceId: resource.id,
        },
      );
    }

    // Authorization gates settlement, so on a free resource nothing would read
    // the proof. Config refuses this at load; this is defense in depth.
    if (resource.pricing.type !== 'fixed' && (resource.authorization?.required.length ?? 0) > 0) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${resource.id}" requires authorization but is not a paid resource`,
        {
          requestId: request.requestId,
          resourceId: resource.id,
        },
      );
    }

    let paymentResult: PaymentResult | undefined;
    let authorization: AuthorizationRecord | undefined;
    let deferredSettlement: SettleArgs | undefined;

    if (resource.pricing.type === 'fixed') {
      const pricing = resource.pricing;
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
      authorization = hold?.record;

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

      const settleArgs: SettleArgs = {
        request,
        resource,
        provider,
        requirement,
        payment,
        verification,
        replayKey,
        hold,
      };
      if (requirement.metadata?.[SETTLE_AFTER_BACKEND_METADATA_KEY] === true) {
        deferredSettlement = settleArgs;
      } else {
        paymentResult = await settle(settleArgs);
      }
    }

    // 6. call backend
    const backendStart = options.clock.monotonicMs();
    let backendResponse: BackendResponse;
    try {
      backendResponse = await options.backend.call(resource.handler, {
        requestId: request.requestId,
        resourceId: resource.id,
        input: validInput,
        ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
      });
    } catch (error) {
      const commerceError = toCommerceError(error, 'BACKEND_ERROR', 'Backend call failed');
      await safeEmit(
        buildEvent({
          type: 'backend.failed',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          status: 'error',
          durationMs: Math.round(options.clock.monotonicMs() - backendStart),
          data: { code: commerceError.code },
        }),
      );

      if (deferredSettlement !== undefined) {
        await abandonSettlement(deferredSettlement, commerceError.code);
        throw commerceError;
      }

      if (paymentResult !== undefined) {
        // The payment settled and the backend then failed. Record an
        // undelivered receipt for the merchant and tell the buyer what they
        // paid, including the settlement reference.
        const failedReceipt: CommerceReceipt = {
          id: options.ids.next('receipt'),
          requestId: request.requestId,
          resourceId: resource.id,
          deliveredAt: options.clock.nowIso(),
          backendStatus: backendErrorStatus(commerceError),
          protocol: request.protocol,
          payment: paymentResult,
          ...(authorization !== undefined ? { authorization } : {}),
          metadata: { delivered: false, backendErrorCode: commerceError.code },
        };
        await safePersist(
          () => options.store.saveReceipt(failedReceipt),
          'saveReceipt(backend-failed-after-settlement)',
          request.requestId,
        );

        throw new CommerceError(
          'BACKEND_ERROR',
          'Payment settled but the backend call failed; the payment was not refunded automatically',
          {
            requestId: request.requestId,
            resourceId: resource.id,
            cause: commerceError,
            details: {
              payment: {
                status: paymentResult.status,
                provider: paymentResult.provider,
                amount: paymentResult.amount,
                currency: paymentResult.currency,
                ...(paymentResult.network !== undefined ? { network: paymentResult.network } : {}),
                ...(paymentResult.externalReference !== undefined
                  ? { externalReference: paymentResult.externalReference }
                  : {}),
                ...(paymentResult.payer !== undefined ? { payer: paymentResult.payer } : {}),
                ...(typeof paymentResult.metadata?.['amountBaseUnits'] === 'string'
                  ? { amountBaseUnits: paymentResult.metadata['amountBaseUnits'] }
                  : {}),
                ...(typeof paymentResult.metadata?.['receipt'] === 'string'
                  ? { receipt: paymentResult.metadata['receipt'] }
                  : {}),
              },
            },
          },
        );
      }

      throw commerceError;
    }

    await safeEmit(
      buildEvent({
        type: 'backend.called',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
        status: 'ok',
        durationMs: backendResponse.durationMs,
        data: { status: backendResponse.status },
      }),
    );

    // Hold the backend response until settlement succeeds. A refusal or
    // uncertain outcome throws before delivery.
    if (deferredSettlement !== undefined) {
      paymentResult = await settle(deferredSettlement);
    }

    // 7. persist receipt, emit final event, return outcome
    const receipt: CommerceReceipt = {
      id: options.ids.next('receipt'),
      requestId: request.requestId,
      resourceId: resource.id,
      deliveredAt: options.clock.nowIso(),
      backendStatus: backendResponse.status,
      durationMs: backendResponse.durationMs,
      protocol: request.protocol,
      ...(paymentResult !== undefined ? { payment: paymentResult } : {}),
      ...(authorization !== undefined ? { authorization } : {}),
    };

    await safePersist(() => options.store.saveReceipt(receipt), 'saveReceipt', request.requestId);

    const totalDurationMs = Math.round(options.clock.monotonicMs() - pipelineStart);

    await safeEmit(
      buildEvent({
        type: 'resource.delivered',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
        status: 'ok',
        durationMs: totalDurationMs,
      }),
    );

    return {
      kind: 'delivered',
      requestId: request.requestId,
      resourceId: resource.id,
      backendStatus: backendResponse.status,
      body: backendResponse.body,
      headers: backendResponse.headers,
      ...(paymentResult !== undefined ? { payment: paymentResult } : {}),
      receipt,
      durationMs: totalDurationMs,
    };
  }

  return { execute };
}

// The status the backend returned, which backend-http.ts puts on
// `details.status` for a non-2xx or redirect response. 0 means no status is
// known, as after a timeout, a transport failure or an unreadable or oversized
// body.
function backendErrorStatus(error: CommerceError): number {
  const status = error.details?.['status'];
  return typeof status === 'number' ? status : 0;
}

// The broadcast transaction hash a provider attached to a settlement throw,
// when it knows one
function settlementTxHash(error: unknown): string | undefined {
  const hash = isCommerceError(error) ? error.details?.['transactionHash'] : undefined;
  return typeof hash === 'string' ? hash : undefined;
}

// The provider for each method a resource requires, in the resource's order.
// Config refuses a method that is not enabled at load; it is checked again
// because missing it here would serve the resource with no authorization.
function resolveAuthorizationProviders(
  providers: readonly AuthorizationProvider[],
  resource: CommerceResource,
  requestId: string,
): readonly AuthorizationProvider[] {
  const required = resource.authorization?.required ?? [];
  return required.map((method: AuthorizationMethodName) => {
    const found = providers.find((provider) => provider.name === method);
    if (!found) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${resource.id}" requires authorization method "${method}", which is not enabled`,
        { requestId, resourceId: resource.id },
      );
    }
    return found;
  });
}

// A refusal leaves this request's challenge unused. Return it with the
// provider's reason so the client can retry without fetching another challenge
function retryChallenge(
  requirement: PaymentRequirement,
  reason?: string,
): { details?: Record<string, unknown> } {
  const envelope = requirement.challenge.envelope;
  if (envelope === undefined && reason === undefined) return {};
  return {
    details: {
      ...(envelope !== undefined ? { challenge: envelope } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

// Attempt statuses the pipeline treats as finished when handling a replay. The
// legacy `failed` is not one: it recorded any throw from settle(), so it may
// hide a transfer, like `settlement-uncertain`.
const FINISHED_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(['settled', 'rejected']);

// Treat a finished attempt as eligible for a 402 with a new challenge. Keep
// 409 when the first attempt is unfinished or its status is unavailable;
// another challenge could lead to a second payment
function finishedReplay(error: CommerceError, requirement: PaymentRequirement): CommerceError {
  const status = error.details?.['attemptStatus'];
  if (error.code !== 'PAYMENT_REPLAYED' || typeof status !== 'string') return error;
  if (!FINISHED_ATTEMPT_STATUSES.has(status)) return error;
  return new CommerceError('PAYMENT_REPLAYED', error.message, {
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.resourceId !== undefined ? { resourceId: error.resourceId } : {}),
    httpStatus: 402,
    details: { ...error.details, ...retryChallenge(requirement).details },
  });
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

const RESERVED_INPUT_KEYS: readonly string[] = [...RESERVED_INPUT_FIELDS, '__proto__'];

function stripReservedFields(input: unknown): unknown {
  if (!isRecord(input)) return input;
  // Object.hasOwn, not `in`, which also matches inherited names
  if (!RESERVED_INPUT_KEYS.some((key) => Object.hasOwn(input, key))) return input;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    // "__proto__" is dropped too: assigning it would call the inherited setter
    // and replace `rest`'s prototype instead of creating a data property.
    // validation.ts's own-property lookups are the primary control.
    if (!RESERVED_INPUT_KEYS.includes(key)) rest[key] = input[key];
  }
  return rest;
}
