/**
 * Gateway-defined wire envelopes and carriers. FROZEN CONTRACT.
 *
 * The HTTP routes and the MCP and A2A adapters build their "payment required"
 * and "error" bodies with these helpers, so those surfaces send the same
 * shapes. The ACP adapter maps errors to ACP's own error format instead.
 */

import { CommerceError, type CommerceErrorCode } from '../errors';
import { isRecord } from '../is-record';
import type { AuthorizationRequirement, AuthorizationSubmission } from './authorization';
import type { DecimalAmount, IsoTimestamp, PaymentMethodName } from './common';
import type { PaymentSubmission } from './payment';
import type { DeliveredOutcome, PaymentRequiredOutcome } from './request';
import type { CommerceResource } from './resource';

/**
 * Reserved input property carrying a payment proof on protocols with no header
 * channel (MCP tool calls, A2A message data). HTTP uses a header instead.
 */
export const PAYMENT_INPUT_FIELD = '_payment';

/**
 * HTTP request header carrying an x402 payment proof. MPP proofs use
 * `Authorization: Payment ...` instead.
 *
 * The x402 v2 header names, lowercased as Node presents incoming headers. v1's
 * `X-PAYMENT` / `X-PAYMENT-RESPONSE` pair is not accepted: honoring both
 * versions would mean two verification paths for the same money.
 */
export const PAYMENT_HEADER = 'payment-signature';

/** HTTP response header carrying the settlement result */
export const PAYMENT_RESPONSE_HEADER = 'payment-response';

/**
 * Reserved input property carrying an authorization proof, the counterpart of
 * {@link PAYMENT_INPUT_FIELD}.
 *
 * `_payment` is a bare string whose method is taken from the resource's first
 * payment method. This field is a `{ method, payload }` object, because the
 * method of a security control should be stated, not inferred.
 */
export const AUTHORIZATION_INPUT_FIELD = '_authorization';

/**
 * Every input property name the gateway claims for itself. The config loader
 * rejects a resource declaring one, protocol adapters lift them out of client
 * input, and the pipeline strips them again as defense in depth.
 */
export const RESERVED_INPUT_FIELDS: readonly string[] = [
  PAYMENT_INPUT_FIELD,
  AUTHORIZATION_INPUT_FIELD,
];

/**
 * HTTP request header carrying the authorization proof: base64url-encoded JSON
 * of the same `{ method, payload }` object the reserved input field carries.
 *
 * An Agent Commerce carrier, not a header from any authorization
 * specification. It is namespaced rather than reusing `Authorization`, which
 * already carries other credentials, including MPP payment proofs.
 */
export const AUTHORIZATION_HEADER = 'agent-authorization';

/**
 * Hard cap on the encoded `Agent-Authorization` header.
 *
 * Node's default limit is 16 KiB across all request headers, and a request over
 * it is refused before the gateway sees it. Capping well below that gives an
 * oversized proof a deterministic `AUTHORIZATION_INVALID` naming the limit.
 */
export const MAX_AUTHORIZATION_HEADER_BYTES = 8192;

/**
 * HTTP response header carrying the base64 x402 challenge on a 402.
 *
 * The body still carries the richer {@link PaymentRequiredEnvelope}, the only
 * channel MCP has, but an x402 v2 client reads the challenge from this header
 * and ignores the body, so both are sent.
 */
export const PAYMENT_REQUIRED_HEADER = 'payment-required';

/**
 * Key under which a protocol adapter attaches a {@link DeliverySummary} to its
 * result metadata: MCP's `CallToolResult._meta` and the A2A task artifact's
 * metadata.
 *
 * Part of the frozen contract because producer and consumer must agree on it;
 * both import this constant. Follows MCP's `<namespace>/<name>` convention for
 * `_meta` keys.
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
    /** Provider-native requirement objects, passed through verbatim */
    readonly accepts: readonly Readonly<Record<string, unknown>>[];
    /**
     * The provider's own challenge document, verbatim (see
     * {@link PaymentChallenge.envelope}). Present for providers that have one;
     * a buyer's protocol client can hand it straight to its SDK.
     */
    readonly envelope?: Readonly<Record<string, unknown>>;
  };
  /**
   * Present only when the resource also requires an authorization proof, so a
   * client learns before it spends anything that paying alone will not get the
   * resource delivered. A client that ignores the field sees the plain
   * envelope. The proof comes from the merchant's own approval flow, outside
   * the gateway.
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
 * What a buyer learns about their own completed purchase: the request, whether
 * it settled, and the settlement reference they can check on-chain. The
 * merchant's ledger is not theirs to read, which is why `/api/receipts` is an
 * operator route behind `server.adminToken`.
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
    /** Settlement reference, e.g. an on-chain transaction hash */
    readonly externalReference?: string;
    readonly network?: string;
  };
}

/** Build the payer-facing summary of a delivered outcome */
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
 * Parses the `{ method, payload }` authorization object, whichever carrier
 * brought it. Absent returns `undefined`; malformed throws
 * `AUTHORIZATION_INVALID`.
 *
 * An unusable `_payment` is dropped, which leaves the buyer a 402 to act on. A
 * dropped authorization would instead come back as "not authorized", with no
 * way to tell a rejected mandate from a typo in the object around it.
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

  if (!isRecord(value)) {
    return fail(`expected an object with "method" and "payload", got ${typeof value}`);
  }
  const method = value['method'];
  const payload = value['payload'];

  // Compared against the literal rather than a registry: a second method needs
  // a second verifier, a deliberate addition rather than a string that starts
  // working because a client sent it
  if (method !== 'ap2') {
    fail(`unsupported method ${typeof method === 'string' ? `"${method}"` : typeof method}`);
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    fail('"payload" must be a non-empty string');
  }

  return { method: 'ap2', payload: payload as string };
}

/**
 * Decodes the base64url JSON `Agent-Authorization` header. The size check runs
 * on the encoded value, so an oversized header costs a length comparison rather
 * than a decode and a JSON parse.
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
    // the input it choked on, which here is whatever the caller sent
    fail('header is not base64url-encoded JSON');
  }
  return parseAuthorizationSubmission(decoded, requestId);
}

/**
 * Splits raw client input into resource input plus the reserved fields, for
 * protocols that carry them in the input object (MCP tool arguments, A2A
 * message data). HTTP carries both in headers.
 *
 * A payment proof is labeled with the resource's first payment method.
 * `createGateway` puts provider-backed methods first so the label matches the
 * pipeline's selection; a custom registry must keep that order. A resource with
 * no payment method gets no payment proof, so the request reaches the pipeline
 * unpaid.
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
