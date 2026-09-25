/**
 * Gateway-defined wire envelopes.
 *
 * FROZEN CONTRACT. These are the *only* representations of "payment required"
 * and "error" that leave the gateway, whichever protocol carries them. The HTTP
 * routes, the MCP adapter and the demo buyer agent all use these helpers so the
 * three can never drift apart.
 */

import { CommerceError, type CommerceErrorCode } from '../errors/index.js';
import type { AuthorizationRequirement, AuthorizationSubmission } from './authorization.js';
import type { DecimalAmount, IsoTimestamp, PaymentMethodName } from './common.js';
import type { PaymentSubmission } from './payment.js';
import type { DeliveredOutcome, PaymentRequiredOutcome } from './request.js';
import type { CommerceResource } from './resource.js';

/**
 * Reserved input property carrying a payment proof on protocols that have no
 * header channel (MCP tool calls). Over HTTP the `PAYMENT-SIGNATURE` header is
 * used.
 */
export const PAYMENT_INPUT_FIELD = '_payment';

/**
 * HTTP request header carrying the payment proof.
 *
 * x402 v2 header names, lowercased because that is how Node presents incoming
 * headers. v1's `X-PAYMENT` / `X-PAYMENT-RESPONSE` pair is not accepted: this
 * gateway speaks one protocol version, and quietly honouring both would mean
 * two verification paths for the same money.
 */
export const PAYMENT_HEADER = 'payment-signature';

/** HTTP response header carrying the settlement result. */
export const PAYMENT_RESPONSE_HEADER = 'payment-response';

/**
 * Reserved input property carrying an authorization proof, the authorization
 * counterpart of {@link PAYMENT_INPUT_FIELD}.
 *
 * Unlike `_payment`, which is a bare string, this one carries an object:
 * `{ method, payload }`. There is exactly one payment rail per resource, so a
 * payment proof's method can be inferred from the resource; an authorization
 * proof cannot lean on that, and guessing the method of a security control is
 * not a thing to do implicitly.
 */
export const AUTHORIZATION_INPUT_FIELD = '_authorization';

/**
 * Every input property name the gateway claims for itself.
 *
 * One list, read by the config loader (which rejects a resource declaring any
 * of them), by the protocol adapters that lift them out of client input, and
 * by the pipeline that strips them again as defence in depth. Those three
 * agree by construction instead of by three copies of two strings.
 */
export const RESERVED_INPUT_FIELDS: readonly string[] = [
  PAYMENT_INPUT_FIELD,
  AUTHORIZATION_INPUT_FIELD,
];

/**
 * HTTP request header carrying the authorization proof, base64url-encoded
 * JSON of the same `{ method, payload }` envelope the reserved input field
 * carries.
 *
 * This is an Agent Commerce transport carrier, not a header defined by any
 * authorization specification, so it is namespaced rather than borrowing
 * `Authorization`, which already means something else on every one of these
 * routes.
 */
export const AUTHORIZATION_HEADER = 'agent-authorization';

/**
 * Hard cap on the encoded `Agent-Authorization` header.
 *
 * Node's own limit is ~16 KiB across *all* request headers, so an
 * authorization near that size would start evicting everything else and fail
 * as an unreadable transport error rather than a legible one. Capping well
 * below it means an oversized proof gets a deterministic
 * AUTHORIZATION_INVALID naming the limit.
 */
export const MAX_AUTHORIZATION_HEADER_BYTES = 8192;

/**
 * HTTP response header carrying the base64 payment challenge on a 402.
 *
 * The 402 body still carries {@link PaymentRequiredEnvelope} — richer, and the
 * only channel MCP has — but an x402 v2 client reads the challenge from this
 * header and ignores the body, so both are sent.
 */
export const PAYMENT_REQUIRED_HEADER = 'payment-required';

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
    /**
     * The provider's own challenge document, verbatim — see
     * {@link PaymentChallenge.envelope}. Present for providers that have one;
     * a buyer's protocol client can hand this straight to its SDK.
     */
    readonly envelope?: Readonly<Record<string, unknown>>;
  };
  /**
   * Present only when the resource requires an authorization proof as well.
   *
   * Additive: a client that does not understand the field sees exactly the
   * envelope it saw before. A client that does learns, before it spends
   * anything, that paying alone will not get the resource delivered.
   *
   * This advertises a requirement; it does not issue anything. The proof is
   * obtained from the merchant's own approval flow, outside the gateway.
   */
  readonly authorization?: {
    readonly required: readonly AuthorizationRequirement[];
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
 * settlement summary in the payment-response header while MCP callers received
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
      ...(r.challenge.envelope !== undefined ? { envelope: r.challenge.envelope } : {}),
    },
    ...(outcome.authorization !== undefined && outcome.authorization.length > 0
      ? { authorization: { required: outcome.authorization } }
      : {}),
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

/**
 * Parses the `{ method, payload }` authorization envelope, whichever carrier
 * brought it.
 *
 * Absent is `undefined`. Present but malformed throws, rather than being
 * dropped the way an unusable `_payment` is. A dropped payment leaves the
 * buyer holding a 402 they can act on. A silently dropped authorization would
 * come back as "not authorized" for a proof the client believes it sent, with
 * no way to tell a rejected mandate from a typo in the envelope around it.
 */
export function parseAuthorizationSubmission(
  value: unknown,
  requestId?: string,
): AuthorizationSubmission | undefined {
  if (value === undefined || value === null) return undefined;

  const fail = (detail: string): never => {
    throw new CommerceError('AUTHORIZATION_INVALID', `Malformed authorization: ${detail}`, {
      ...(requestId !== undefined ? { requestId } : {}),
    });
  };

  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`expected an object with "method" and "payload", got ${typeof value}`);
  }
  const record = value as Record<string, unknown>;
  const method = record['method'];
  const payload = record['payload'];

  // 'ap2' is the only method in this release. Compared against the literal
  // rather than a registry: a second method means a second verifier, and that
  // is a deliberate addition, not a string that should start working because
  // a client sent it.
  if (method !== 'ap2') {
    fail(`unsupported method ${typeof method === 'string' ? `"${method}"` : typeof method}`);
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    fail('"payload" must be a non-empty string');
  }

  return { method: 'ap2', payload: payload as string };
}

/**
 * Decodes the base64url-JSON `Agent-Authorization` header.
 *
 * The size check runs on the encoded value before any decoding, so an
 * oversized header costs a length comparison rather than a base64 decode and
 * a JSON parse of whatever a caller chose to send.
 */
export function parseAuthorizationHeader(
  raw: string | readonly string[] | undefined,
  requestId?: string,
): AuthorizationSubmission | undefined {
  const value = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  if (value === undefined || value.length === 0) return undefined;

  const fail = (detail: string): never => {
    throw new CommerceError('AUTHORIZATION_INVALID', `Malformed authorization: ${detail}`, {
      ...(requestId !== undefined ? { requestId } : {}),
    });
  };

  if (Buffer.byteLength(value, 'utf8') > MAX_AUTHORIZATION_HEADER_BYTES) {
    fail(`header exceeds the ${MAX_AUTHORIZATION_HEADER_BYTES}-byte limit`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    // Nothing from the exception is repeated back: a JSON parse error quotes
    // the input it choked on, which here is whatever the caller sent.
    fail('header is not base64url-encoded JSON');
  }
  return parseAuthorizationSubmission(decoded, requestId);
}

/**
 * Splits raw client input into resource input plus the reserved fields the
 * gateway claims, for every protocol that carries them in the input object
 * (MCP tool arguments, A2A message data). HTTP carries both in headers and
 * uses the two parse helpers directly.
 *
 * A payment proof is labelled with the resource's first method. `createGateway`
 * puts provider-backed methods first so the label matches pipeline selection;
 * custom registries must preserve that ordering. Without a method, the proof is
 * dropped and the pipeline receives an unpaid request.
 */
export function extractReservedInputFields(
  rawInput: Record<string, unknown>,
  resource: CommerceResource | undefined,
  requestId?: string,
): {
  input: Record<string, unknown>;
  payment?: PaymentSubmission;
  authorization?: AuthorizationSubmission;
} {
  const {
    [PAYMENT_INPUT_FIELD]: paymentValue,
    [AUTHORIZATION_INPUT_FIELD]: authorizationValue,
    ...input
  } = rawInput;

  const method = resource?.paymentMethods[0];
  const payment =
    typeof paymentValue === 'string' && paymentValue.length > 0 && method !== undefined
      ? ({ method, payload: paymentValue } satisfies PaymentSubmission)
      : undefined;
  const authorization = parseAuthorizationSubmission(authorizationValue, requestId);

  return {
    input,
    ...(payment !== undefined ? { payment } : {}),
    ...(authorization !== undefined ? { authorization } : {}),
  };
}
