/**
 * Canonical request/response model for the execution pipeline.
 *
 * FROZEN CONTRACT. Protocol adapters normalize into `CanonicalRequest` and map
 * `ExecutionOutcome` (or a thrown `CommerceError`) back into their own wire
 * format. Adapters must never call merchant backends directly.
 */
import type { AuthorizationRequirement, AuthorizationSubmission } from './authorization';
import type { IsoTimestamp, ProtocolName } from './common';
import type { PaymentRequirement, PaymentResult, PaymentSubmission } from './payment';
import type { CommerceReceipt } from './receipt';

export interface CanonicalRequest {
  /** Correlation id for the entire flow, generated at ingress. A client never chooses it */
  readonly requestId: string;
  readonly resourceId: string;
  /** Raw resource input. The pipeline validates it against the resource schema */
  readonly input: unknown;
  readonly protocol: ProtocolName;
  /** Payment proof, when the client is retrying after a challenge */
  readonly payment?: PaymentSubmission;
  /**
   * Authorization proof, when the resource requires one. Neither it nor
   * `payment` substitutes for the other: a resource requiring authorization
   * needs both.
   */
  readonly authorization?: AuthorizationSubmission;
  readonly receivedAt: IsoTimestamp;
  /**
   * Stable name for the side-effecting operation, when the protocol has one.
   * Passed on as `BackendRequest.idempotencyKey`.
   */
  readonly idempotencyKey?: string;
  /** Adapter headers passed to the backend; configured headers take precedence */
  readonly backendHeaders?: Readonly<Record<string, string>>;
  /** Non-secret transport metadata, such as client id or user agent */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Successful delivery of a resource */
export interface DeliveredOutcome {
  readonly kind: 'delivered';
  readonly requestId: string;
  readonly resourceId: string;
  readonly backendStatus: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payment?: PaymentResult;
  readonly receipt: CommerceReceipt;
  readonly durationMs: number;
}

/** The resource costs money and the request carried no payment proof */
export interface PaymentRequiredOutcome {
  readonly kind: 'payment-required';
  readonly requestId: string;
  readonly resourceId: string;
  readonly requirement: PaymentRequirement;
  /** Authorization the buyer must also present on the retry, when the resource requires one */
  readonly authorization?: readonly AuthorizationRequirement[];
}

/**
 * Result of a pipeline execution. Every other condition (unknown resource,
 * invalid input, rejected payment, backend or storage failure) is a thrown
 * `CommerceError`.
 */
export type ExecutionOutcome = DeliveredOutcome | PaymentRequiredOutcome;

/**
 * The single execution path every protocol adapter converges on.
 *
 * It signals in two ways. A missing payment is a normal return value
 * (`PaymentRequiredOutcome`): an expected protocol step whose caller reads the
 * challenge and retries with a proof. Everything else that goes wrong,
 * including a rejected payment, is a thrown `CommerceError`. Adapters handle
 * both:
 *
 * ```ts
 * try {
 *   const outcome = await pipeline.execute(request);
 *   if (outcome.kind === 'payment-required') return toPaymentRequiredEnvelope(outcome);
 *   return renderDelivered(outcome);
 * } catch (error) {
 *   return toErrorEnvelope(toCommerceError(error));
 * }
 * ```
 */
export interface ExecutionPipeline {
  execute(request: CanonicalRequest): Promise<ExecutionOutcome>;
}
