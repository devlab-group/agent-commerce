/**
 * Canonical payment model. FROZEN CONTRACT.
 *
 * Core decides that a payment is required and for how much. Payment providers
 * decide how the challenge is encoded, verified and settled. No x402- or
 * EVM-specific type may appear in this file.
 */
import type {
  AdapterDescriptor,
  AdapterHealth,
  DecimalAmount,
  IsoTimestamp,
  PaymentMethodName,
} from './common';
import type { PaymentAttempt } from './receipt';
import type { CommerceResource } from './resource';

/**
 * `PaymentResult.metadata` key for public coordinates returned by `verify`
 * for later provider reconciliation. Core must store the value unchanged and
 * interpret only `expiresAt`. Never include signatures, payloads or
 * transaction bytes. Experimental: may change in a minor release.
 */
export const RECONCILIATION_METADATA_KEY = 'reconciliation';

/**
 * Provider-native payment challenge, opaque to core. For x402 the `accepts`
 * entries are x402 `PaymentRequirements` objects, passed to protocol adapters
 * verbatim.
 */
export interface PaymentChallenge {
  readonly provider: PaymentMethodName;
  /** Provider protocol version, e.g. the x402 `x402Version` value as a string */
  readonly version: string;
  readonly accepts: readonly Readonly<Record<string, unknown>>[];
  /**
   * The provider's own challenge document, verbatim: for x402 v2 the
   * `PaymentRequired` object a buyer's client consumes, for MPP an object
   * carrying the serialized `WWW-Authenticate` challenge. Opaque to core.
   *
   * `accepts` alone is not that document: x402 v2 carries the resource
   * description and protocol version on the envelope. Adapters with a native
   * channel for it (x402's `PAYMENT-REQUIRED` header, MPP's `WWW-Authenticate`)
   * send it there as is, so every surface offers the same challenge.
   */
  readonly envelope?: Readonly<Record<string, unknown>>;
}

/**
 * What the buyer must pay, in canonical terms, plus the provider-native
 * challenge the buyer's client needs to construct a payment
 */
export interface PaymentRequirement {
  readonly id: string;
  readonly requestId: string;
  readonly resourceId: string;
  readonly provider: PaymentMethodName;
  readonly amount: DecimalAmount;
  readonly currency: string;
  /**
   * Merchant-controlled settlement destination, never a gateway-owned wallet.
   * Multi-offer challenges omit this, `network` and `asset`; selection
   * supplies the chosen offer's terms.
   */
  readonly destination?: string;
  readonly network?: string;
  readonly asset?: string;
  readonly expiresAt?: IsoTimestamp;
  readonly challenge: PaymentChallenge;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Opaque payment proof supplied by the buyer's client. For x402 over HTTP it is
 * the base64 `PAYMENT-SIGNATURE` header value; over MCP and A2A it is the same
 * string in the reserved `_payment` input field.
 */
export interface PaymentSubmission {
  readonly method: PaymentMethodName;
  readonly payload: string;
}

/** Outcome of verification or settlement */
export interface PaymentResult {
  readonly status: 'verified' | 'settled' | 'rejected';
  readonly provider: PaymentMethodName;
  /** Settlement reference, e.g. an on-chain transaction hash */
  readonly externalReference?: string;
  readonly payer?: string;
  readonly payee?: string;
  readonly amount: DecimalAmount;
  readonly currency: string;
  readonly network?: string;
  readonly asset?: string;
  /**
   * Stable, provider-computed identity of the payment authorization.
   *
   * The pipeline reserves this key before settlement and rejects a second
   * request presenting it with `PAYMENT_REPLAYED`. Providers must derive it
   * only from the authorization (payer, nonce, asset, network), so the same
   * authorization always maps to the same key.
   */
  readonly replayKey?: string;
  /** Machine-readable rejection reason when status is `rejected` */
  readonly rejectionReason?: string;
  readonly settledAt?: IsoTimestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input to {@link PaymentProvider.createRequirement} */
export interface PaymentContext {
  readonly requestId: string;
  readonly resource: CommerceResource;
  readonly amount: DecimalAmount;
  readonly currency: string;
  readonly requestedAt: IsoTimestamp;
  /**
   * Validated resource input used to build the backend request. The pipeline
   * sets this field on every createRequirement call. A rail may bind its
   * challenge to the input but must not send it to a third party.
   */
  readonly input?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input to {@link PaymentProvider.verify} */
export interface PaymentVerificationContext {
  readonly requestId: string;
  readonly resource: CommerceResource;
  readonly requirement: PaymentRequirement;
  readonly submission: PaymentSubmission;
}

/** Input to {@link PaymentProvider.settle} */
export interface PaymentSettlementContext extends PaymentVerificationContext {
  readonly verification: PaymentResult;
}

/** Input to {@link PaymentProvider.reconcile}. Experimental: may change in a minor release */
export interface PaymentReconciliationContext {
  readonly attempt: PaymentAttempt;
  /** Coordinates from `verify`; optional for compatibility with pre-2.5.0 attempts */
  readonly locator?: Readonly<Record<string, unknown>>;
  readonly now: IsoTimestamp;
}

/** Chain evidence for resolving an attempt. Experimental: may change in a minor release */
export interface PaymentReconciliationResult {
  /**
   * Report `settled` only with a final transfer record for this authorization.
   * Report `not-settled` only when a state read proves it unused after it can
   * no longer land; missing logs or receipts are insufficient. Otherwise,
   * report `unknown`.
   */
  readonly outcome: 'settled' | 'not-settled' | 'unknown';
  /** A machine-readable token, such as `not_final` */
  readonly reason: string;
  readonly externalReference?: string;
  /** Public chain facts only */
  readonly evidence?: Readonly<Record<string, unknown>>;
  /** For `unknown`, the earliest time a different answer is possible, if known */
  readonly retryAfter?: IsoTimestamp;
}

/**
 * Contract every payment rail implements. Implementations must be
 * non-custodial: they orchestrate an external payment protocol and never hold
 * buyer or merchant production signing keys.
 */
export interface PaymentProvider {
  readonly name: PaymentMethodName;
  readonly descriptor: AdapterDescriptor;

  /**
   * Build the requirement and its challenge. The pipeline calls it for every
   * paid request, including one that already carries a proof to verify.
   */
  createRequirement(context: PaymentContext): Promise<PaymentRequirement>;

  /**
   * Selects a proof's offer before verification, returning its destination,
   * network, asset and metadata while preserving `id` and the full `challenge`.
   * Verification, authorization, replay reservation and settlement use the result.
   * This hook must not verify, reserve or settle. If no unique offer matches,
   * return the original requirement for `verify` to reject.
   */
  selectRequirement?(context: PaymentVerificationContext): Promise<PaymentRequirement>;

  /**
   * Validate a submitted proof against the requirement. Must return `rejected`
   * or throw a `CommerceError` rather than an untyped error, and must never
   * move funds.
   */
  verify(context: PaymentVerificationContext): Promise<PaymentResult>;

  /**
   * Execute settlement. Called only after `verify` returned `verified` and the
   * replay key was reserved. A settlement verdict, including a rejection, is a
   * returned result; the pipeline records any throw as settlement-uncertain.
   */
  settle(context: PaymentSettlementContext): Promise<PaymentResult>;

  /**
   * Read chain evidence for an attempt with an unknown outcome. Implementations
   * must not write, broadcast or call a facilitator. Providers without this
   * hook require manual resolution. Experimental: may change in a minor release.
   */
  reconcile?(context: PaymentReconciliationContext): Promise<PaymentReconciliationResult>;

  health(): Promise<AdapterHealth>;
}
