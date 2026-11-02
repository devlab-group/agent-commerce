/**
 * Persistence boundary for receipts, events and payment attempts, implemented
 * by src/storage/receipts. Core depends only on this interface, never on
 * SQLite.
 */
import type { AuthorizationRecord } from '../domain/authorization';
import type {
  AdapterDescriptor,
  AdapterHealth,
  IsoTimestamp,
  ProtocolName,
} from '../domain/common';
import type { CommerceEvent } from '../domain/event';
import type { CommerceReceipt, PaymentAttempt, PaymentAttemptResolution } from '../domain/receipt';
import type {
  AuthorizationHold,
  AuthorizationHoldReservation,
  AuthorizationHoldResult,
  IdempotencyClaim,
  IdempotencyScope,
  IdempotencyUpdate,
  PendingTask,
} from '../domain/store-records';
import type {
  AuthorizationHoldState,
  PersistenceFailure,
  Transaction,
  TransactionState,
} from '../domain/transaction';

export interface PaymentAttemptReservation {
  readonly requestId: string;
  readonly resourceId: string;
  readonly provider: string;
  /** Must be unique across the store; see `PaymentResult.replayKey` */
  readonly replayKey: string;
  readonly amount: string;
  readonly currency: string;
  readonly payer?: string;
  readonly payee?: string;
  /**
   * Reclaim this `replayKey` if the same `provider` rejected it, which
   * settled nothing. Set only for rails whose authorizations remain reusable
   * until settled.
   */
  readonly reclaimRejected?: boolean;
  /**
   * Journal data to write atomically with the reservation. Stores without
   * journal support ignore it.
   */
  readonly transaction?: NewTransaction;
}

/**
 * Data for a journal row opened with a replay reservation. Journal stores
 * must initialize an included authorization hold as `reserved`. The reservation
 * supplies the request, resource, provider, replay key, amount, currency and
 * payee.
 */
export interface NewTransaction {
  readonly id: string;
  readonly protocol: ProtocolName;
  readonly network?: string;
  readonly asset?: string;
  readonly locator?: Readonly<Record<string, unknown>>;
  readonly expiresAt?: IsoTimestamp;
  readonly authorization?: AuthorizationRecord & { readonly reservationId: string };
  readonly inputDigest?: string;
  readonly configDigest: string;
}

/** A journal update after replay reservation */
export type TransactionStep = {
  readonly transactionId: string;
  readonly at: IsoTimestamp;
} & (
  | { readonly kind: 'settling' }
  | { readonly kind: 'hold'; readonly hold: AuthorizationHoldState }
  | { readonly kind: 'backend-dispatched'; readonly deadlineAt: IsoTimestamp }
  | { readonly kind: 'backend-result'; readonly status: number; readonly errorCode?: string }
  | { readonly kind: 'receipt'; readonly receiptId: string }
  | {
      readonly kind: 'completed';
      readonly persistenceFailures?: readonly PersistenceFailure[];
    }
);

export interface TransactionListOptions extends ListOptions {
  /** Opaque cursor from a previous page's `nextCursor` */
  readonly cursor?: string;
  readonly state?: TransactionState;
  /** When true, exclude `delivered` and `payment-failed` states */
  readonly unresolved?: boolean;
  /** When true, filter for `reserved` or `uncertain` authorization holds */
  readonly pendingHold?: boolean;
}

/** Transactions in newest-first order */
export interface TransactionPage {
  readonly transactions: readonly Transaction[];
  /**
   * Continue with this cursor even when filtering returns fewer than `limit`
   * transactions, including an empty page. Pagination ends when it is absent.
   */
  readonly nextCursor?: string;
}

export interface PaymentAttemptResolveRequest {
  readonly attemptId: string;
  /** Update only if the attempt still has this status and no resolution */
  readonly expectedStatus: PaymentAttempt['status'];
  readonly status: 'settled' | 'rejected';
  readonly rejectionReason?: string;
  readonly resolution: PaymentAttemptResolution;
}

export interface PaymentAttemptUpdate {
  readonly replayKey: string;
  readonly status: PaymentAttempt['status'];
  readonly externalReference?: string;
  readonly rejectionReason?: string;
}

export interface ListOptions {
  readonly limit?: number;
  readonly requestId?: string;
}

export interface ReceiptListOptions extends ListOptions {
  /**
   * When true, return only receipts counted by {@link ReceiptStore.countUndeliveredReceipts}.
   * Stores ignoring this flag also return delivered receipts.
   */
  readonly undelivered?: boolean;
}

export interface PaymentAttemptListOptions extends ListOptions {
  /**
   * When true, return only attempts counted by {@link ReceiptStore.countUncertainPaymentAttempts}.
   * Stores that ignore this flag do not filter by settlement status.
   */
  readonly uncertain?: boolean;
}

export interface ReceiptStore {
  init(): Promise<void>;

  /** Append a canonical event. Must not throw into the caller's flow */
  appendEvent(event: CommerceEvent): Promise<void>;

  /**
   * Atomically reserve a payment authorization before settlement. If its
   * `replayKey` is already reserved, throws `CommerceError('PAYMENT_REPLAYED')`
   * with the existing attempt's `PaymentAttempt.status` in
   * `details.attemptStatus` when available.
   *
   * With `reclaimRejected`, replace the same provider's `rejected` attempt,
   * which settled nothing. Only one concurrent claim can replace it with the
   * new reservation.
   */
  reservePaymentAttempt(reservation: PaymentAttemptReservation): Promise<PaymentAttempt>;

  /** Must not change an attempt that has a resolution; the SQLite store throws `STORAGE_ERROR` */
  updatePaymentAttempt(update: PaymentAttemptUpdate): Promise<void>;

  saveReceipt(receipt: CommerceReceipt): Promise<void>;
  getReceipt(id: string): Promise<CommerceReceipt | undefined>;
  listReceipts(options?: ReceiptListOptions): Promise<readonly CommerceReceipt[]>;

  /**
   * Total receipts held. `listReceipts` clamps every page, so counting a list's
   * length would stop at the clamp.
   */
  countReceipts(): Promise<number>;

  /**
   * Receipts whose delivery failed: `backendStatus` outside 2xx, including 0
   * when no status is known. Counted rather than listed for the same reason as
   * {@link countReceipts}.
   *
   * In practice this is "paid but undelivered": the pipeline writes a receipt
   * for a failed delivery only after a settled payment, so a free resource
   * whose backend fails leaves no row here. It is the row a merchant must
   * notice, because settlement is final and the gateway issues no refunds.
   */
  countUndeliveredReceipts(): Promise<number>;

  /**
   * Counts `settlement-uncertain` and legacy `failed` payment attempts.
   * Funds may have moved, but the pipeline withholds delivery and writes no
   * receipt for an uncertain settlement. {@link countUndeliveredReceipts}
   * therefore misses these attempts. Reconcile them on chain using
   * `externalReference` when it holds a transaction hash.
   */
  countUncertainPaymentAttempts(): Promise<number>;
  listEvents(options?: ListOptions): Promise<readonly CommerceEvent[]>;
  listPaymentAttempts(options?: PaymentAttemptListOptions): Promise<readonly PaymentAttempt[]>;

  /**
   * Record a journal step. Journal methods are optional for compatibility with
   * stores that do not support the journal. Implementations must also recompute
   * a transaction's cached state atomically with payment-attempt updates.
   */
  recordTransactionStep?(step: TransactionStep): Promise<void>;
  getTransaction?(id: string): Promise<Transaction | undefined>;
  listTransactions?(options?: TransactionListOptions): Promise<TransactionPage>;
  getPaymentAttempt?(id: string): Promise<PaymentAttempt | undefined>;
  /**
   * Returns the current attempt holding `replayKey`, excluding attempts
   * replaced by a reclaim. If a rejected proof carries this key, the pipeline
   * uses the lookup to return `PAYMENT_REPLAYED` while its attempt is unfinished.
   * Experimental: may change in a minor release.
   */
  findPaymentAttemptByReplayKey?(replayKey: string): Promise<PaymentAttempt | undefined>;
  /**
   * Compare-and-set: return `false` without writing if the attempt's status
   * differs from `expectedStatus` or it already has a resolution
   */
  resolvePaymentAttempt?(request: PaymentAttemptResolveRequest): Promise<boolean>;

  /**
   * Idempotency claims for protocol adapters. A store must implement all three
   * methods or none. Experimental: may change in a minor release.
   *
   * Atomically claim `scope` after deleting `completed` claims whose
   * `expiresAt` has passed. Other states do not expire. Return `reserved` for
   * a new scope, or `conflict` for a different `fingerprint`, regardless of
   * the existing claim's state.
   */
  claimIdempotencyKey?(
    scope: IdempotencyScope,
    fingerprint: string,
    expiresAt: IsoTimestamp,
  ): Promise<IdempotencyClaim>;
  /** Record a claim's outcome. Experimental: may change in a minor release */
  updateIdempotencyKey?(scope: IdempotencyScope, update: IdempotencyUpdate): Promise<void>;
  /**
   * Call at startup before accepting claims. Mark every `in-flight` claim
   * `unresolved`, or delete them if `release` is true. Return the number
   * changed. Assumes one gateway per store. Experimental: may change in a
   * minor release.
   */
  recoverIdempotencyKeys?(options: { readonly release: boolean }): Promise<number>;

  /**
   * Authorization holds for authorization providers. A store must implement
   * all four methods or none. Experimental: may change in a minor release.
   *
   * Atomically reserve a hold. Return `replayed` with the existing holder's
   * state if this reference, or another with the same `bindingReference`, is
   * not `released`. A released reference can be reserved again by the new
   * `requestId`.
   */
  reserveAuthorizationHold?(
    reservation: AuthorizationHoldReservation,
  ): Promise<AuthorizationHoldResult>;
  /**
   * Move a `reserved` or `uncertain` hold to `to`. This method leaves
   * `consumed` and `released` holds unchanged. When supplied, `requestId`
   * restricts changes to that request's hold. Return true when the hold is
   * in `to`, including on repeated calls. If `requestId` no longer holds the
   * reference, leave the current hold unchanged and return true only when
   * `to` is `released`. Return false otherwise. Experimental: may change in
   * a minor release.
   */
  transitionAuthorizationHold?(
    reference: string,
    to: Exclude<AuthorizationHoldState, 'reserved'>,
    requestId?: string,
  ): Promise<boolean>;
  /** Experimental: may change in a minor release */
  getAuthorizationHoldState?(reference: string): Promise<AuthorizationHoldState | undefined>;
  /**
   * List `reserved` holds last updated before `updatedBefore`, oldest first,
   * whose request has no current or replaced payment attempt. The pipeline
   * reserves an attempt before settlement, so after the request ends it cannot
   * settle a payment for such a hold. Experimental: may change in a minor
   * release.
   */
  listOrphanAuthorizationHolds?(options: {
    readonly updatedBefore: IsoTimestamp;
    readonly limit?: number;
  }): Promise<readonly AuthorizationHold[]>;

  /**
   * Pending tasks for protocol adapters. A store must implement all three
   * methods or none. Experimental: may change in a minor release.
   *
   * Delete expired tasks, then store `task`, replacing any task with the same
   * ID. Return false without storing when `maxTasks` unexpired tasks exist.
   */
  putPendingTask?(task: PendingTask, options: { readonly maxTasks: number }): Promise<boolean>;
  /** Return undefined for a missing or expired task. Experimental: may change in a minor release */
  getPendingTask?(id: string): Promise<PendingTask | undefined>;
  /**
   * Atomically delete and return the task. Return undefined if it has expired
   * or a concurrent or earlier call already took it. Experimental: may change
   * in a minor release.
   */
  takePendingTask?(id: string): Promise<PendingTask | undefined>;

  readonly descriptor: AdapterDescriptor;
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}
