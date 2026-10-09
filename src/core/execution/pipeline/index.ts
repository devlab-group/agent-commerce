/**
 * The single execution path every protocol adapter converges on. The order is a
 * security boundary; do not reorder:
 *
 * 1. resolve resource (RESOURCE_NOT_FOUND)
 * 2. strip reserved input fields, validate input and the backend request shape
 *    (INPUT_INVALID, or BACKEND_ERROR for an illegal configured header)
 * 3. resolve price
 * 4. free: straight to the backend
 * 5. paid: pick provider and createRequirement, then return a challenge, or
 *    select the offer the proof pays, verify it, and reserve authorization and
 *    replay identities
 * 6. settle before calling the backend, or call the backend first and settle
 *    only if it succeeds. Finalize authorization according to the outcome
 *    (BACKEND_TIMEOUT / BACKEND_ERROR)
 * 7. persist receipt, emit events, return outcome
 */

import type { AuthorizationRecord } from '../../domain/authorization';
import type { PaymentResult } from '../../domain/payment';
import type { CommerceReceipt } from '../../domain/receipt';
import type { CanonicalRequest, ExecutionOutcome, ExecutionPipeline } from '../../domain/request';
import type { CommerceResource } from '../../domain/resource';
import { RESERVED_INPUT_FIELDS } from '../../domain/wire';
import { CommerceError, toCommerceError } from '../../errors';
import type { BackendResponse } from '../../interfaces/backend';
import { isRecord } from '../../is-record';
import { validateBackendRequestShape } from '../backend-request';
import { SETTLE_AFTER_BACKEND_METADATA_KEY } from '../settlement-order';
import { compileJsonSchema, type Validator } from '../validation';
import { createPaymentAdmission } from './admission';
import { createAuthorizeAndReserve } from './authorization';
import {
  type CreateExecutionPipelineOptions,
  createPipelineContext,
  type SettleArgs,
} from './context';
import { createSettlement } from './settlement';

export type { CreateExecutionPipelineOptions } from './context';

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

  const ctx = createPipelineContext(options);
  const { safeEmit, safePersist, buildEvent } = ctx;
  const { settle, abandonSettlement } = createSettlement(ctx);
  const admitPayment = createPaymentAdmission(ctx, createAuthorizeAndReserve(ctx));

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
    validateBackendRequestShape(
      resource.handler,
      validInput,
      { requestId: request.requestId, resourceId: resource.id },
      request.backendHeaders,
    );

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
      const admission = await admitPayment(request, resource, resource.pricing, validInput);
      if (admission.kind === 'payment-required') return admission;
      const { settleArgs } = admission;
      authorization = settleArgs.hold?.record;
      if (settleArgs.requirement.metadata?.[SETTLE_AFTER_BACKEND_METADATA_KEY] === true) {
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
        ...(request.backendHeaders !== undefined ? { backendHeaders: request.backendHeaders } : {}),
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
