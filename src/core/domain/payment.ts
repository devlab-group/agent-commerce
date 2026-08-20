/**
 * Canonical payment model.
 *
 * FROZEN CONTRACT.
 *
 * Core decides *that* a payment is required and for how much.
 * Payment providers decide *how* the challenge is encoded, verified and settled.
 * No x402/EVM-specific type may appear in this file.
 */
import type {
  AdapterDescriptor,
  AdapterHealth,
  DecimalAmount,
  IsoTimestamp,
  PaymentMethodName,
} from './common.js';
import type { CommerceResource } from './resource.js';

/**
 * Provider-native payment challenge, opaque to core.
 *
 * For x402 the `accepts` entries are x402 `PaymentRequirements` objects; core
 * passes them through to protocol adapters verbatim and never inspects them.
 */
export interface PaymentChallenge {
  readonly provider: PaymentMethodName;
  /** Provider protocol version, e.g. the x402 `x402Version` value as a string. */
  readonly version: string;
  readonly accepts: readonly Readonly<Record<string, unknown>>[];
}

/**
 * What the buyer must pay, in canonical terms, plus the provider-native
 * challenge the buyer's client needs in order to construct a payment.
 */
export interface PaymentRequirement {
  readonly id: string;
  readonly requestId: string;
  readonly resourceId: string;
  readonly provider: PaymentMethodName;
  readonly amount: DecimalAmount;
  readonly currency: string;
  /** Merchant-controlled settlement destination. Never a gateway-owned wallet. */
  readonly destination: string;
  readonly network?: string;
  readonly asset?: string;
  readonly expiresAt?: IsoTimestamp;
  readonly challenge: PaymentChallenge;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Opaque payment proof supplied by the buyer's client.
 *
 * For x402 over HTTP this is the base64 `X-PAYMENT` header value; over MCP it
 * is the same string carried in the tool input's `_payment` field.
 */
export interface PaymentSubmission {
  readonly method: PaymentMethodName;
  readonly payload: string;
}

/** Outcome of verification or settlement. */
export interface PaymentResult {
  readonly status: 'verified' | 'settled' | 'rejected';
  readonly provider: PaymentMethodName;
  /** Settlement reference, e.g. an on-chain transaction hash. */
  readonly externalReference?: string;
  readonly payer?: string;
  readonly payee?: string;
  readonly amount: DecimalAmount;
  readonly currency: string;
  readonly network?: string;
  readonly asset?: string;
  /**
   * Stable, provider-computed identity of the payment authorisation itself.
   *
   * The gateway reserves this key before settlement and rejects any second
   * request presenting the same key (see PAYMENT_REPLAYED). Providers MUST
   * derive it only from the authorisation (payer, nonce, asset, network) so
   * that the same authorisation always maps to the same key.
   */
  readonly replayKey?: string;
  /** Machine-readable rejection reason when status is `rejected`. */
  readonly rejectionReason?: string;
  readonly settledAt?: IsoTimestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input to {@link PaymentProvider.createRequirement}. */
export interface PaymentContext {
  readonly requestId: string;
  readonly resource: CommerceResource;
  readonly amount: DecimalAmount;
  readonly currency: string;
  readonly requestedAt: IsoTimestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input to {@link PaymentProvider.verify}. */
export interface PaymentVerificationContext {
  readonly requestId: string;
  readonly resource: CommerceResource;
  readonly requirement: PaymentRequirement;
  readonly submission: PaymentSubmission;
}

/** Input to {@link PaymentProvider.settle}. */
export interface PaymentSettlementContext extends PaymentVerificationContext {
  readonly verification: PaymentResult;
}

/**
 * Contract every payment rail implements.
 *
 * Implementations must be non-custodial: they orchestrate an external payment
 * protocol and must never hold buyer or merchant production signing keys.
 */
export interface PaymentProvider {
  readonly name: PaymentMethodName;
  readonly descriptor: AdapterDescriptor;

  /** Build the challenge presented to an unpaid request. */
  createRequirement(context: PaymentContext): Promise<PaymentRequirement>;

  /**
   * Validate a submitted proof against the requirement.
   *
   * Must return `rejected` (or throw a CommerceError) rather than throwing an
   * untyped error. Must never have side effects that move funds.
   */
  verify(context: PaymentVerificationContext): Promise<PaymentResult>;

  /** Execute settlement. Called only after `verify` returned `verified`. */
  settle(context: PaymentSettlementContext): Promise<PaymentResult>;

  health(): Promise<AdapterHealth>;
}
