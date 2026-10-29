/**
 * Canonical transaction model. FROZEN CONTRACT.
 *
 * A transaction links a paid purchase's request, payment attempt, optional
 * authorization hold, backend call and receipt by ID. PaymentAttempt owns the
 * payment status; journal readers must read it from the attempt rather than
 * maintain a separate copy.
 */
import type { AuthorizationRecord } from './authorization';
import type { DecimalAmount, IsoTimestamp, PaymentMethodName, ProtocolName } from './common';
import type { PaymentAttempt } from './receipt';

/**
 * States derived by {@link transactionState}. Experimental: may change in a
 * minor release.
 */
export const TRANSACTION_STATES = [
  'payment-pending',
  'payment-failed',
  'payment-uncertain',
  'settled-undelivered',
  'delivery-started',
  'delivery-unknown',
  'delivered',
] as const;

/**
 * Open to state names added by later releases; consumers must handle values
 * outside {@link TRANSACTION_STATES}. Experimental: may change in a minor release.
 */
export type TransactionState = (typeof TRANSACTION_STATES)[number] | (string & {});

/** Last hold state communicated to the authorization provider */
export type AuthorizationHoldState = 'reserved' | 'consumed' | 'released' | 'uncertain';

/**
 * Store writes reported as failed during an execution. Consumers must handle
 * unlisted labels that later releases may add.
 */
export type PersistenceFailure = 'payment-attempt' | 'receipt' | 'journal' | (string & {});

/**
 * Journal record for a paid purchase, starting with replay reservation.
 * Store only references and digests, never payment proofs, signatures, mandates
 * or input bodies. Experimental: may change in a minor release.
 */
export interface Transaction {
  readonly id: string;
  /** The request that created it */
  readonly requestId: string;
  readonly resourceId: string;
  readonly protocol: ProtocolName;
  /** Cached derived state; readers must recompute it with {@link transactionState} */
  readonly state: TransactionState;
  readonly payment: {
    readonly provider: PaymentMethodName;
    readonly attemptId: string;
    readonly replayKey: string;
    /** Read from PaymentAttempt, not maintained independently */
    readonly status: PaymentAttempt['status'];
    readonly amount: DecimalAmount;
    readonly currency: string;
    readonly network?: string;
    readonly asset?: string;
    readonly payee?: string;
    readonly externalReference?: string;
    /**
     * Public coordinates for the provider's `reconcile` hook, governed by
     * `RECONCILIATION_METADATA_KEY`
     */
    readonly locator?: Readonly<Record<string, unknown>>;
    /** When the provider's `settle` was called */
    readonly settlingAt?: IsoTimestamp;
    /** The authorization cannot land after this */
    readonly expiresAt?: IsoTimestamp;
  };
  readonly authorization?: AuthorizationRecord & {
    /** The handle the authorization provider consumes or releases */
    readonly reservationId: string;
    readonly hold: AuthorizationHoldState;
  };
  readonly backend?: {
    readonly dispatchedAt: IsoTimestamp;
    /** Dispatch time plus the backend timeout and a margin */
    readonly deadlineAt: IsoTimestamp;
    /** 0 if the call ended without a status, such as a timeout or transport failure */
    readonly status?: number;
    readonly errorCode?: string;
  };
  readonly receiptId?: string;
  /** `sha256:` followed by the canonical JSON input digest in hex; omit for non-I-JSON input */
  readonly inputDigest?: string;
  /** Digest of pricing and settlement terms, excluding credentials */
  readonly configDigest: string;
  readonly persistenceFailures?: readonly PersistenceFailure[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** Time of the pipeline's last journal write before returning the outcome */
  readonly completedAt?: IsoTimestamp;
}

/** What {@link transactionState} reads */
export type TransactionFacts = Pick<Transaction, 'backend' | 'completedAt'> & {
  readonly payment: Pick<Transaction['payment'], 'status'>;
};

const isSuccess = (status: number): boolean => status >= 200 && status <= 299;

/**
 * Derive state from payment status, backend facts and pipeline completion.
 * For a settled payment, a dispatched call with no result after `deadlineAt`
 * means `delivery-unknown`; a timeout does not prove that the backend never ran.
 * Experimental: may change in a minor release.
 */
export function transactionState(
  facts: TransactionFacts,
  now: IsoTimestamp,
): (typeof TRANSACTION_STATES)[number] {
  const { payment, backend, completedAt } = facts;
  if (payment.status === 'settlement-uncertain' || payment.status === 'failed') {
    return 'payment-uncertain';
  }
  if (payment.status === 'rejected') return 'payment-failed';

  // Invalid timestamps make the comparison false, treating the deadline as passed
  const waiting =
    backend !== undefined &&
    completedAt === undefined &&
    Date.parse(now) < Date.parse(backend.deadlineAt);
  if (payment.status !== 'settled') {
    return waiting && backend?.status === undefined ? 'delivery-started' : 'payment-pending';
  }

  if (backend === undefined) return 'settled-undelivered';
  const { status } = backend;
  if (status !== undefined && status !== 0 && !isSuccess(status)) return 'settled-undelivered';
  if (status !== undefined && isSuccess(status) && completedAt !== undefined) return 'delivered';
  // Wait until the deadline for a missing result or an unfinished 2xx flow.
  // Status 0 means the call already ended without a response.
  if (status !== 0 && waiting) return 'delivery-started';
  return 'delivery-unknown';
}
