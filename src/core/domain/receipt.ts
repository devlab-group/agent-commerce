// Canonical receipt model. FROZEN CONTRACT
import type { AuthorizationRecord } from './authorization';
import type { IsoTimestamp } from './common';
import type { PaymentResult } from './payment';

export interface CommerceReceipt {
  readonly id: string;
  readonly requestId: string;
  /** Optional for compatibility with rows written before 2.5.0 */
  readonly transactionId?: string;
  readonly resourceId: string;
  /** Absent for free resources */
  readonly payment?: PaymentResult;
  /**
   * Present only when the resource required authorization. A method and a digest,
   * so the receipt records that consent existed without storing the proof.
   */
  readonly authorization?: AuthorizationRecord;
  readonly deliveredAt: IsoTimestamp;
  readonly backendStatus: number;
  readonly durationMs?: number;
  readonly protocol?: string;
  /** Non-secret summary only, never a sensitive backend body */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Record of a single payment authorization seen by the gateway */
export interface PaymentAttempt {
  readonly id: string;
  readonly requestId: string;
  /** Optional for compatibility with rows written before 2.5.0 */
  readonly transactionId?: string;
  readonly resourceId: string;
  readonly provider: string;
  /** Unique across the store; see `PaymentResult.replayKey` */
  readonly replayKey: string;
  /**
   * State of the authorization, as far as the gateway can prove it.
   *
   * `settlement-uncertain` means settlement was attempted and no verdict came
   * back (RPC timeout, dropped connection, a facilitator that accepted the
   * transfer and lost the response). The transfer may or may not have
   * happened, so the attempt is unresolved rather than terminal and needs
   * evidence from the chain, not a retry. `externalReference` holds the
   * broadcast transaction hash when one is known.
   *
   * The execution pipeline never writes `failed`: a throw out of `settle()`
   * never proves that nothing moved. It stays in the union because existing
   * databases hold rows with that status.
   */
  readonly status:
    | 'reserved'
    | 'verified'
    | 'settled'
    | 'rejected'
    | 'failed'
    | 'settlement-uncertain';
  readonly amount: string;
  readonly currency: string;
  readonly payer?: string;
  readonly payee?: string;
  readonly externalReference?: string;
  readonly rejectionReason?: string;
  /** Records how an unresolved attempt became `settled` or `rejected` after its request ended */
  readonly resolution?: PaymentAttemptResolution;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Who resolved an attempt, manually or by reconciliation, and why */
export interface PaymentAttemptResolution {
  readonly method: 'reconcile' | 'manual';
  /** Caller-supplied identity; the admin token does not identify an individual */
  readonly actor: string;
  readonly reason: string;
  readonly at: IsoTimestamp;
  /** For `manual`, an unverified reference supplied by the operator */
  readonly externalReference?: string;
  /** Public chain facts only */
  readonly evidence?: Readonly<Record<string, unknown>>;
}
