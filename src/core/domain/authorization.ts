/**
 * Canonical authorization model.
 *
 * FROZEN CONTRACT.
 *
 * Authorization answers a different question from payment. Payment proves
 * that funds moved; authorization proves that the human behind the agent
 * approved *this exact purchase*. A valid authorization never unlocks a paid
 * resource on its own and never moves money. It gates settlement, and a
 * resource that requires one still needs a real payment proof as well.
 *
 * Core decides *that* a resource requires authorization and *when* in the
 * pipeline it is checked. Authorization providers decide how a submission is
 * parsed, verified and bound to the purchase. No AP2, SD-JWT or JWT type may
 * appear in this file.
 */
import type { AdapterDescriptor, AdapterHealth, AuthorizationMethodName } from './common.js';
import type { PaymentRequirement } from './payment.js';

/**
 * Opaque authorization proof supplied by the buyer's client.
 *
 * Over HTTP this arrives base64url-JSON-encoded in the `Agent-Authorization`
 * header; over MCP and A2A it is the same `{ method, payload }` object carried
 * in the reserved `_authorization` input field.
 *
 * `payload` is preserved byte-for-byte from the wire. Providers derive replay
 * identities by hashing it, so decoding and reserialising it before it reaches
 * the provider would change the identity of an otherwise identical proof.
 */
export interface AuthorizationSubmission {
  readonly method: AuthorizationMethodName;
  readonly payload: string;
}

/**
 * What a buyer must present, advertised alongside the payment challenge so a
 * client learns before it pays that a proof of payment alone will not do.
 *
 * The gateway never issues the authorization itself. It states the method,
 * the spec version it verifies against, and the payload profile it expects.
 */
export interface AuthorizationRequirement {
  readonly method: AuthorizationMethodName;
  readonly version: string;
  readonly profile?: string;
}

/**
 * Safe audit identity of an authorization, fit for a receipt. `reference` is a
 * digest: a receipt outlives its request, and a stored proof would be a
 * spendable secret at rest.
 */
export interface AuthorizationRecord {
  readonly method: AuthorizationMethodName;
  readonly reference: string;
  /** Safe audit summary only. Never the proof, its disclosures, or PII */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A verified, reserved authorization. `reservationId` is the live handle the
 * pipeline consumes, releases or marks uncertain once settlement resolves; it
 * stays out of the record above because a handle is not an audit fact.
 */
export interface AuthorizationVerification extends AuthorizationRecord {
  readonly status: 'verified';
  readonly reservationId: string;
}

/** Input to {@link AuthorizationProvider.verifyAndReserve}. */
export interface AuthorizationVerificationContext {
  readonly requestId: string;
  readonly resourceId: string;
  /**
   * The validated resource input, reserved fields already stripped: the same
   * bytes the merchant backend will be called with. A provider that binds a
   * proof to the request hashes this, so it must not include `_payment`,
   * `_authorization`, the request id or any transport metadata.
   */
  readonly input: unknown;
  readonly submission: AuthorizationSubmission;
  /** The resolved price and destination the proof must match. */
  readonly requirement: PaymentRequirement;
}

/** Input to {@link AuthorizationProvider.consume} and `release`. */
export interface AuthorizationFinalizeContext {
  readonly requestId: string;
  readonly resourceId: string;
}

/**
 * Contract every authorization method implements.
 *
 * The lifecycle straddles settlement: a proof must be reserved *before* funds
 * move so a replay cannot race one, and its fate is only known *after*.
 *
 * Release only for a failure that provably moved no money. Anything ambiguous
 * is marked uncertain: a proof handed back after a settlement that may have
 * landed can be spent twice.
 */
export interface AuthorizationProvider {
  readonly name: AuthorizationMethodName;
  readonly descriptor: AdapterDescriptor;
  /** What a buyer must present, advertised beside the payment challenge */
  readonly requirement: AuthorizationRequirement;

  /**
   * Verify a submission against the resolved purchase and atomically reserve
   * it against reuse.
   *
   * Throws a `CommerceError` with an `AUTHORIZATION_*` code, never a payment
   * code. A verifier or store outage is
   * `AUTHORIZATION_PROVIDER_UNAVAILABLE`, not the buyer's fault.
   */
  verifyAndReserve(context: AuthorizationVerificationContext): Promise<AuthorizationVerification>;

  /** Mark a reservation permanently spent. Called after settlement succeeds. */
  consume(reservationId: string, context: AuthorizationFinalizeContext): Promise<void>;

  /** Return a reservation to unused. Only for failures that moved no funds. */
  release(reservationId: string, context: AuthorizationFinalizeContext): Promise<void>;

  /**
   * Settlement broadcast but never confirmed: neither spend the reservation
   * nor hand it back, and flag it for an operator
   */
  markUncertain(reservationId: string, context: AuthorizationFinalizeContext): Promise<void>;

  health(): Promise<AdapterHealth>;
}
