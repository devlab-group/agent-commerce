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
 * A verified, reserved authorization.
 *
 * `reference` is a safe stable identity (a digest, never the proof itself) fit
 * for a receipt. `reservationId` is the handle the pipeline later consumes or
 * releases depending on how settlement went.
 */
export interface AuthorizationVerification {
  readonly status: 'verified';
  readonly method: AuthorizationMethodName;
  readonly reference: string;
  readonly reservationId: string;
  /** Safe audit summary only. Never the proof, its disclosures, or PII. */
  readonly metadata?: Readonly<Record<string, unknown>>;
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
 * The lifecycle is verify -> reserve -> settlement outcome -> consume/release.
 * The two halves straddle settlement because a proof has to be reserved
 * *before* funds move, so a replay cannot race a settlement, and its fate is
 * only known *after*. Releasing is for failures that provably moved no money.
 * Anything ambiguous is consumed rather than handed back: an authorization
 * handed back after an uncertain settlement can be spent a second time.
 */
export interface AuthorizationProvider {
  readonly name: AuthorizationMethodName;
  readonly descriptor: AdapterDescriptor;

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

  health(): Promise<AdapterHealth>;
}
