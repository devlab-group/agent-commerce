/**
 * The single execution path every protocol adapter converges on.
 *
 * Order is a security boundary — do not reorder:
 * 1. resolve resource RESOURCE_NOT_FOUND
 * 2. strip reserved input fields, validate input INPUT_INVALID
 * 3. resolve price
 * 4. free -> straight to backend
 * 5. paid -> pick provider -> createRequirement -> (challenge | verify ->
 * authorize/reserve -> reserve replay key -> settle -> consume/release the
 * authorization), fail closed at every step
 * 6. call backend BACKEND_TIMEOUT / BACKEND_ERROR
 * 7. persist receipt, emit events, return outcome
 */

import type {
  AuthorizationProvider,
  AuthorizationRecord,
  AuthorizationVerification,
} from '../domain/authorization.js';
import type { AuthorizationMethodName, PaymentMethodName } from '../domain/common.js';
import type { CommerceEvent, EventSink } from '../domain/event.js';
import type { PaymentProvider, PaymentRequirement, PaymentResult } from '../domain/payment.js';
import type { CommerceReceipt } from '../domain/receipt.js';
import type { CanonicalRequest, ExecutionOutcome, ExecutionPipeline } from '../domain/request.js';
import type { CommerceResource, ResourceRegistry } from '../domain/resource.js';
import { RESERVED_INPUT_FIELDS } from '../domain/wire.js';
import { CommerceError, isCommerceError, toCommerceError } from '../errors/index.js';
import type { BackendExecutor, BackendResponse } from '../interfaces/backend.js';
import type { Logger } from '../interfaces/logger.js';
import type { Clock, IdGenerator } from '../interfaces/runtime.js';
import type { ReceiptStore } from '../interfaces/store.js';
import { validateBackendRequestShape } from './backend-http.js';
import { compileJsonSchema, type Validator } from './validation.js';

export interface CreateExecutionPipelineOptions {
  readonly resources: ResourceRegistry;
  readonly paymentProviders: readonly PaymentProvider[];
  /** Empty by default, so a deployment configuring none is unchanged */
  readonly authorizationProviders?: readonly AuthorizationProvider[];
  readonly store: ReceiptStore;
  readonly backend: BackendExecutor;
  readonly events: EventSink;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * A reservation held across settlement, plus the summary the receipt keeps.
 * `finalize` is the only way it ends, so no path can leave one open.
 */
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

  /**
   * Verify and reserve what the resource requires, or undefined if it requires
   * none. Runs after payment verification, which has no side effect: a bad
   * payment proof must not burn a reservation.
   */
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
          // Any failure leaves the row reserved, which is still unspendable.
          // Not worth replacing the outcome the caller is about to see.
          options.logger.error(
            { err: describeError(error), requestId: request.requestId, action },
            'Authorization finalization failed; the reservation stays reserved',
          );
        }
      },
    };
  }

  async function execute(request: CanonicalRequest): Promise<ExecutionOutcome> {
    const pipelineStart = options.clock.monotonicMs();

    // 1. resolve resource
    const resource = options.resources.get(request.resourceId);
    // Same code, same message as a genuine miss: `expose` is an admin scoping
    // decision enforced on the one execution path every adapter shares — a
    // caller on a protocol the resource isn't exposed via must not be able to
    // distinguish "doesn't exist" from "exists but not for you".
    if (!resource || !resource.exposedVia.includes(request.protocol)) {
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

    // validate the backend request shape (path-traversal, query-param
    // collision) here — before price resolution, so a resource that fails
    // this check never reaches payment. Both checks are pure functions of
    // (handler.url, input); doing them at pipeline step 6 (inside the actual
    // backend call) meant a bad value like `{ city: "" }` against a paid,
    // path-templated resource settled the buyer's payment and then never
    // called the backend at all — payment without delivery. call() keeps its
    // own copy of these checks as defence in depth.
    validateBackendRequestShape(resource.handler, validInput, {
      requestId: request.requestId,
      resourceId: resource.id,
    });

    // 3. resolve price
    if (resource.pricing.type === 'dynamic') {
      // Config validation rejects this before the gateway starts; this is defence-in-depth.
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${resource.id}" uses unsupported dynamic pricing`,
        {
          requestId: request.requestId,
          resourceId: resource.id,
        },
      );
    }

    // Authorization gates settlement, so requiring one on a free resource
    // means nothing would ever read the proof. Config refuses it at load; the
    // execution path must not be the one that serves it unchecked.
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
        // Any typed CommerceError the provider throws is rethrown as-is (a
        // provider can legitimately fail with STORAGE_ERROR, etc. — flattening
        // every code to PAYMENT_INVALID would hide the real cause and the
        // real, possibly-retryable HTTP status). Only a genuinely untyped
        // throw is mapped, with a fixed client-facing message — never the
        // raw error's own message.
        const mapped = isCommerceError(error)
          ? error
          : new CommerceError('PAYMENT_INVALID', 'Payment verification failed', {
              requestId: request.requestId,
              resourceId: resource.id,
              cause: error,
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
        // The store contract only promises PAYMENT_REPLAYED for an actual
        // duplicate replayKey (already a CommerceError with that code, so
        // isCommerceError below preserves it as-is). Anything else — a disk-
        // full error, a dropped connection — is a storage failure, not a
        // replay, and must not be mislabelled as one: telling a buyer
        // "duplicate payment" for a transient outage is actively false, and
        // poisons any alerting keyed on replay counts.
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
        throw mapped;
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
        // A verdict arrives as a *returned* PaymentResult, settled or
        // rejected. A throw means no verdict was obtained, and no throw on
        // this rail can say whether the transfer happened: a facilitator can
        // accept a settlement, broadcast it, then lose the response to a
        // timeout, a reset or a proxy 502. "No transaction hash" is not
        // evidence of "no transfer", only evidence that we never heard one.
        // So every throw out of settle() is uncertain: the attempt is
        // recorded unresolved and the authorization hold is kept, because a
        // released mandate is spendable again with a fresh payment
        // authorization against a charge that may already have landed. Only
        // a returned `rejected` below - the facilitator's own statement that
        // nothing moved - releases it. The resource is not delivered either
        // way: only what gets *recorded* changes, never the fail-closed
        // outcome.
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
        // The merchant's record now tells the truth (above); the buyer must
        // too - they are the party whose funds may have moved, and the
        // client-visible error is their only way to find out. Code stays
        // PAYMENT_SETTLEMENT_FAILED, not the retryable
        // PAYMENT_PROVIDER_UNAVAILABLE: a retry would reuse the
        // already-reserved replay key, and paying again is the one thing an
        // unresolved settlement must never invite. The correlation id is the
        // envelope's requestId; the transaction hash, when there is one, is
        // safe to disclose, being the buyer's own payment and public
        // on-chain the moment it lands. Nothing else from the underlying
        // error travels.
        throw new CommerceError('PAYMENT_SETTLEMENT_FAILED', 'Settlement could not be confirmed', {
          requestId: request.requestId,
          resourceId: resource.id,
          cause: error,
          details: {
            settlementUncertain: true,
            ...(txHash !== undefined ? { transactionHash: txHash } : {}),
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
        throw new CommerceError(
          'PAYMENT_SETTLEMENT_FAILED',
          settlement.rejectionReason ?? 'Settlement was rejected',
          {
            requestId: request.requestId,
            resourceId: resource.id,
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

      paymentResult = settlement;
    }

    // 6. call backend
    const backendStart = options.clock.monotonicMs();
    let backendResponse: BackendResponse;
    try {
      backendResponse = await options.backend.call(resource.handler, {
        requestId: request.requestId,
        resourceId: resource.id,
        input: validInput,
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

      if (paymentResult !== undefined) {
        // Settlement already succeeded (verify -> reserve -> settle all
        // completed) before the backend call failed, so the
        // uncertain-settlement rule ("the merchant's record now tells the
        // truth; the buyer must too") applies to this far more common
        // *certain*-loss branch as well, not only to the uncertain-RPC-timeout
        // one 100 lines above. A backend 500 is more likely than an RPC
        // confirmation timeout, so disclosing strictly *less* here than there
        // would be backwards. The tx hash is
        // safe to disclose: it is the buyer's own payment, public
        // on-chain the moment it lands.
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

/** The HTTP status the backend actually returned, when known (backend-http.ts
 * attaches it as `details.status` for a non-2xx response). 0 means "no
 * response was received at all" (timeout/transport failure) — distinct from
 * any real HTTP status. */
function backendErrorStatus(error: CommerceError): number {
  const status = error.details?.['status'];
  return typeof status === 'number' ? status : 0;
}

// The broadcast transaction hash a provider attached to a settlement throw,
// when it knows one. Absent far more often than not: the response that would
// have carried it is usually the thing that went missing
function settlementTxHash(error: unknown): string | undefined {
  const hash = isCommerceError(error) ? error.details?.['transactionHash'] : undefined;
  return typeof hash === 'string' ? hash : undefined;
}

/**
 * The provider for each method a resource requires, in the resource's order.
 *
 * Config refuses an unconfigured method at load. Missing it here would mean
 * serving the resource with no authorization at all, so it is checked again.
 */
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

const RESERVED_INPUT_KEYS = new Set([...RESERVED_INPUT_FIELDS, '__proto__']);

function stripReservedFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  // Object.hasOwn: `in` would also match inherited names and strip things
  // that were never actually present on this input.
  const hasReserved = [...RESERVED_INPUT_KEYS].some((key) => Object.hasOwn(record, key));
  if (!hasReserved) return input;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    // "__proto__" is dropped, not just excluded from the reserved-field
    // check: `rest[key] = record[key]` for key === "__proto__" would invoke
    // the inherited setter and reassign rest's own prototype instead of
    // creating a data property (belt-and-braces — validation.ts's
    // Object.hasOwn fix is the primary control).
    if (!RESERVED_INPUT_KEYS.has(key)) rest[key] = record[key];
  }
  return rest;
}

function describeError(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error) };
}
