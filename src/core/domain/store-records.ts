/**
 * Protocol-neutral records for the receipt store's optional methods:
 * idempotency claims, authorization holds and pending tasks. Adapters and
 * authorization providers map their own data to these types at their boundaries.
 */
import type { AuthorizationMethodName, IsoTimestamp, ProtocolName } from './common';
import type { AuthorizationHoldState } from './transaction';

/** Experimental: may change in a minor release */
export interface IdempotencyScope {
  /** The gateway's public base URL, which survives a credential rotation */
  readonly deployment: string;
  /** The concrete endpoint path, so a client may reuse one key across operations */
  readonly endpoint: string;
  readonly key: string;
}

/**
 * Prefix reserved for paid retry claim endpoints, followed by the resource ID.
 * ACP endpoints begin with `/`, keeping the claim namespaces distinct.
 */
export const PAYMENT_KEY_ENDPOINT_PREFIX = 'payment:';

/**
 * Result of claiming an idempotency key. `owner` is the tag the claim was
 * created with, if any. Experimental: may change in a minor release.
 */
export type IdempotencyClaim =
  /** The caller owns the key and must perform the operation */
  | { readonly kind: 'reserved' }
  /** Same fingerprint; an earlier claim is still in flight */
  | { readonly kind: 'in-flight'; readonly owner?: string }
  /** Same fingerprint; an earlier attempt's outcome is unknown */
  | { readonly kind: 'unresolved'; readonly owner?: string }
  /** A different fingerprint, regardless of the claim's state */
  | { readonly kind: 'conflict' }
  /** Same fingerprint; replay the stored response */
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown };

/**
 * An idempotency claim's outcome. `body` must be JSON-serializable.
 * Experimental: may change in a minor release.
 */
export type IdempotencyUpdate =
  /** Store the response for later claims with the same fingerprint to replay */
  | { readonly kind: 'completed'; readonly status: number; readonly body: unknown }
  /** Keep the claim without a response and refuse retries: the operation may have run */
  | { readonly kind: 'unresolved' }
  /** Delete only if no backend call ran or the backend deduplicates by this key */
  | { readonly kind: 'released' };

/** Experimental: may change in a minor release */
export interface AuthorizationHoldReservation {
  readonly method: AuthorizationMethodName;
  /** Identifies one authorization, unique across the store. AP2: the issuer-signed token's digest */
  readonly reference: string;
  /** Identifies a binding with at most one unreleased hold. AP2: the checkout JWT's `jti` */
  readonly bindingReference: string;
  readonly resourceId: string;
  readonly requestId: string;
  /** Non-secret operator identifiers, such as issuers; never presentations or signatures */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Experimental: may change in a minor release */
export type AuthorizationHoldResult =
  | { readonly kind: 'reserved' }
  /** The reference or its binding is already held; refuse the authorization */
  | { readonly kind: 'replayed'; readonly state: AuthorizationHoldState };

/** Experimental: may change in a minor release */
export interface AuthorizationHold extends AuthorizationHoldReservation {
  readonly state: AuthorizationHoldState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * A purchase awaiting its payment message. Experimental: may change in a
 * minor release.
 */
export interface PendingTask {
  /** Unique across the store */
  readonly id: string;
  readonly protocol: ProtocolName;
  readonly resourceId: string;
  /**
   * JSON-serializable purchase input with reserved fields removed. Must not
   * contain payment proofs or authorization presentations.
   */
  readonly input: Readonly<Record<string, unknown>>;
  /** JSON-serializable data that only the adapter interprets */
  readonly adapterData?: Readonly<Record<string, unknown>>;
  /** Set and bounded by the caller */
  readonly expiresAt: IsoTimestamp;
}
