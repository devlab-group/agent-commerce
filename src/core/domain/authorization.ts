/**
 * Canonical authorization model. FROZEN CONTRACT.
 *
 * Payment proves that funds moved; authorization proves that the human behind
 * the agent approved this exact purchase. A valid authorization gates
 * settlement but never unlocks a paid resource on its own and never moves
 * money, so a resource that requires one still needs a payment proof.
 *
 * Core decides that a resource requires authorization and when the pipeline
 * checks it. Authorization providers decide how a submission is parsed,
 * verified and bound to the purchase. No AP2, SD-JWT or JWT type may appear in
 * this file.
 */
import type { AdapterDescriptor, AdapterHealth, AuthorizationMethodName } from './common';
import type { PaymentRequirement } from './payment';

/**
 * Opaque authorization proof supplied by the buyer's client. Over HTTP it
 * arrives as base64url JSON in the `Agent-Authorization` header; over MCP and
 * A2A it is the same `{ method, payload }` object in the reserved
 * `_authorization` input field.
 *
 * `payload` is kept byte for byte from the wire. It may hold signed or
 * encoding-sensitive provider data, so transport adapters must not normalize
 * it.
 */
export interface AuthorizationSubmission {
  readonly method: AuthorizationMethodName;
  readonly payload: string;
}

/**
 * What a buyer must present, advertised with the payment challenge so a client
 * learns before it pays that a payment proof alone will not do. The gateway
 * never issues the authorization; it names the method, the spec version it
 * verifies against and the payload profile it expects.
 */
export interface AuthorizationRequirement {
  readonly method: AuthorizationMethodName;
  readonly version: string;
  readonly profile?: string;
}

/**
 * Safe audit identity of an authorization, fit for a receipt. `reference` is a
 * digest, because a receipt outlives its request and a stored proof would be a
 * spendable secret at rest.
 */
export interface AuthorizationRecord {
  readonly method: AuthorizationMethodName;
  readonly reference: string;
  /** Safe audit summary only. Never the proof, its disclosures, or PII */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A verified, reserved authorization. `reservationId` is the handle the
 * pipeline consumes, releases or marks uncertain once the payment resolves. It
 * stays out of `AuthorizationRecord` because a handle is not an audit fact.
 */
export interface AuthorizationVerification extends AuthorizationRecord {
  readonly status: 'verified';
  readonly reservationId: string;
}

/** Input to {@link AuthorizationProvider.verifyAndReserve} */
export interface AuthorizationVerificationContext {
  readonly requestId: string;
  readonly resourceId: string;
  /**
   * The validated resource input with reserved fields stripped: the same value
   * the merchant backend is called with. A provider that binds a proof to the
   * request hashes it, so it excludes `_payment`, `_authorization`, the request
   * id and transport metadata.
   */
  readonly input: unknown;
  readonly submission: AuthorizationSubmission;
  /** The resolved price and destination the proof must match */
  readonly requirement: PaymentRequirement;
}

/** Input to {@link AuthorizationProvider.consume}, `release` and `markUncertain` */
export interface AuthorizationFinalizeContext {
  readonly requestId: string;
  readonly resourceId: string;
}

/**
 * Contract every authorization method implements.
 *
 * The lifecycle straddles settlement: a proof is reserved before funds move, so
 * a replay cannot race it, and its fate is known only afterwards. A reservation
 * is released only after a failure that provably moved no money. Anything
 * ambiguous is marked uncertain, because a proof handed back after a settlement
 * that may have landed can be spent twice.
 */
export interface AuthorizationProvider {
  readonly name: AuthorizationMethodName;
  readonly descriptor: AdapterDescriptor;
  /** What a buyer must present, advertised with the payment challenge */
  readonly requirement: AuthorizationRequirement;

  /**
   * Verify a submission against the resolved purchase and atomically reserve it
   * against reuse. Throws a `CommerceError` with an `AUTHORIZATION_*` code,
   * never a payment code; a verifier or store outage is
   * `AUTHORIZATION_PROVIDER_UNAVAILABLE`, not the buyer's fault.
   */
  verifyAndReserve(context: AuthorizationVerificationContext): Promise<AuthorizationVerification>;

  /** Mark a reservation permanently spent. Called after settlement succeeds */
  consume(reservationId: string, context: AuthorizationFinalizeContext): Promise<void>;

  /** Return a reservation to unused. Only for failures that moved no funds */
  release(reservationId: string, context: AuthorizationFinalizeContext): Promise<void>;

  /**
   * Settlement threw, so whether funds moved is unknown: neither spend the
   * reservation nor hand it back, and flag it for an operator
   */
  markUncertain(reservationId: string, context: AuthorizationFinalizeContext): Promise<void>;

  health(): Promise<AdapterHealth>;
}
