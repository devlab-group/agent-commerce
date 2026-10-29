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
 * payee. Experimental: may change in a minor release.
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

/**
 * A journal update after replay reservation. Experimental: may change in a
 * minor release.
 */
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

/** Experimental: may change in a minor release */
export interface TransactionListOptions extends ListOptions {
  /** Opaque cursor from a previous page's `nextCursor` */
  readonly cursor?: string;
  readonly state?: TransactionState;
  /** When true, exclude `delivered` and `payment-failed` states */
  readonly unresolved?: boolean;
  /** When true, filter for `reserved` or `uncertain` authorization holds */
  readonly pendingHold?: boolean;
}

/** Transactions in newest-first order. Experimental: may change in a minor release */
export interface TransactionPage {
  readonly transactions: readonly Transaction[];
  /**
   * Continue with this cursor even when filtering returns fewer than `limit`
   * transactions, including an empty page. Pagination ends when it is absent.
   */
  readonly nextCursor?: string;
}

/** Experimental: may change in a minor release */
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
   * Experimental: may change in a minor release.
   */
  recordTransactionStep?(step: TransactionStep): Promise<void>;
  getTransaction?(id: string): Promise<Transaction | undefined>;
  listTransactions?(options?: TransactionListOptions): Promise<TransactionPage>;
  getPaymentAttempt?(id: string): Promise<PaymentAttempt | undefined>;
  /**
   * Compare-and-set: return `false` without writing if the attempt's status
   * differs from `expectedStatus` or it already has a resolution
   */
  resolvePaymentAttempt?(request: PaymentAttemptResolveRequest): Promise<boolean>;

  readonly descriptor: AdapterDescriptor;
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}
