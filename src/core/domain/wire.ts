/**
 * Gateway-defined wire envelopes.
 *
 * FROZEN CONTRACT. These are the *only* representations of "payment required"
 * and "error" that leave the gateway, whichever protocol carries them. The HTTP
 * routes, the MCP adapter and the demo buyer agent all use these helpers so the
 * three can never drift apart.
 */

import type { CommerceError, CommerceErrorCode } from '../errors/index.js';
import type { DecimalAmount, IsoTimestamp, PaymentMethodName } from './common.js';
import type { DeliveredOutcome, PaymentRequiredOutcome } from './request.js';

/**
 * Reserved input property carrying a payment proof on protocols that have no
 * header channel (MCP tool calls). Over HTTP the `X-PAYMENT` header is used.
 */
export const PAYMENT_INPUT_FIELD = '_payment';

/** HTTP header carrying the payment proof. */
export const PAYMENT_HEADER = 'x-payment';

/** HTTP response header carrying the settlement reference. */
export const PAYMENT_RESPONSE_HEADER = 'x-payment-response';

/**
 * Key under which a protocol adapter attaches a {@link DeliverySummary} to its
 * result metadata — MCP's `CallToolResult._meta`, and anywhere else a protocol
 * offers an out-of-band metadata channel.
 *
 * Frozen deliberately. The bug this whole mechanism exists to fix was two
 * surfaces disagreeing about what a payer gets back; a key name enforced only
 * by one side's tests would reintroduce exactly that drift. Producer and
 * consumer both import this constant.
 *
 * Follows MCP's `<namespace>/<name>` convention for `_meta` keys.
 */
export const DELIVERY_SUMMARY_META_KEY = 'agent-commerce/delivery';

export interface PaymentRequiredEnvelope {
  readonly status: 'payment-required';
  readonly code: 'PAYMENT_REQUIRED';
  readonly requestId: string;
  readonly resourceId: string;
  readonly message: string;
  readonly payment: {
    readonly provider: PaymentMethodName;
    readonly version: string;
    readonly amount: DecimalAmount;
    readonly currency: string;
    readonly destination: string;
    readonly network?: string;
    readonly asset?: string;
    readonly expiresAt?: IsoTimestamp;
    /** Provider-native requirement objects, passed through verbatim. */
    readonly accepts: readonly Readonly<Record<string, unknown>>[];
  };
}

export interface ErrorEnvelope {
  readonly status: 'error';
  readonly code: CommerceErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly resourceId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * What a buyer learns about their own completed purchase.
 *
 * A payer is entitled to the record of their own transaction — the request it
 * belonged to, whether it settled, and the settlement reference they can check
 * on-chain. They are NOT entitled to the merchant's ledger, which is why
 * `/api/receipts` is an operator route behind `server.adminToken`.
 *
 * Before this existed the two surfaces disagreed: HTTP callers received a
 * settlement summary in `X-PAYMENT-RESPONSE` while MCP callers received
 * nothing, so an MCP buyer's only route to their own receipt was the merchant's
 * ledger. Both surfaces now emit this same shape.
 */
export interface DeliverySummary {
  readonly requestId: string;
  readonly resourceId: string;
  readonly receiptId: string;
  readonly deliveredAt: IsoTimestamp;
  readonly payment?: {
    readonly status: 'verified' | 'settled' | 'rejected';
    readonly amount: DecimalAmount;
    readonly currency: string;
    /** Settlement reference, e.g. an on-chain transaction hash. */
    readonly externalReference?: string;
    readonly network?: string;
  };
}

/** Build the payer-facing summary of a delivered outcome. */
export function toDeliverySummary(outcome: DeliveredOutcome): DeliverySummary {
  const p = outcome.payment;
  return {
    requestId: outcome.requestId,
    resourceId: outcome.resourceId,
    receiptId: outcome.receipt.id,
    deliveredAt: outcome.receipt.deliveredAt,
    ...(p !== undefined
      ? {
          payment: {
            status: p.status,
            amount: p.amount,
            currency: p.currency,
            ...(p.externalReference !== undefined
              ? { externalReference: p.externalReference }
              : {}),
            ...(p.network !== undefined ? { network: p.network } : {}),
          },
        }
      : {}),
  };
}

export function toPaymentRequiredEnvelope(
  outcome: PaymentRequiredOutcome,
): PaymentRequiredEnvelope {
  const r = outcome.requirement;
  return {
    status: 'payment-required',
    code: 'PAYMENT_REQUIRED',
    requestId: outcome.requestId,
    resourceId: outcome.resourceId,
    message: `Payment of ${r.amount} ${r.currency} is required for resource "${outcome.resourceId}". Retry with a ${r.provider} payment proof.`,
    payment: {
      provider: r.provider,
      version: r.challenge.version,
      amount: r.amount,
      currency: r.currency,
      destination: r.destination,
      ...(r.network !== undefined ? { network: r.network } : {}),
      ...(r.asset !== undefined ? { asset: r.asset } : {}),
      ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
      accepts: r.challenge.accepts,
    },
  };
}

export function toErrorEnvelope(error: CommerceError): ErrorEnvelope {
  const info = error.toInfo();
  return {
    status: 'error',
    code: info.code,
    message: info.message,
    retryable: info.retryable,
    ...(info.requestId !== undefined ? { requestId: info.requestId } : {}),
    ...(info.resourceId !== undefined ? { resourceId: info.resourceId } : {}),
    ...(info.details !== undefined ? { details: info.details } : {}),
  };
}

export function isPaymentRequiredEnvelope(value: unknown): value is PaymentRequiredEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as PaymentRequiredEnvelope).status === 'payment-required' &&
    typeof (value as PaymentRequiredEnvelope).payment === 'object'
  );
}
