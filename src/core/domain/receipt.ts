/**
 * Canonical receipt model.
 *
 * FROZEN CONTRACT.
 */
import type { IsoTimestamp } from './common.js';
import type { PaymentResult } from './payment.js';

export interface CommerceReceipt {
  readonly id: string;
  readonly requestId: string;
  readonly resourceId: string;
  /** Absent for free resources. */
  readonly payment?: PaymentResult;
  readonly deliveredAt: IsoTimestamp;
  readonly backendStatus: number;
  readonly durationMs?: number;
  readonly protocol?: string;
  /** Non-secret summary only. Never the full backend body if it is sensitive. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Record of a single payment authorisation seen by the gateway. */
export interface PaymentAttempt {
  readonly id: string;
  readonly requestId: string;
  readonly resourceId: string;
  readonly provider: string;
  /** See PaymentResult.replayKey — unique across the store. */
  readonly replayKey: string;
  /**
   * Terminal state of the authorisation.
   *
   * `settlement-uncertain` is deliberately distinct from `failed`: it means the
   * settlement transaction was broadcast but its outcome could not be
   * confirmed (RPC timeout, dropped connection). "The RPC did not answer" and
   * "the transfer did not happen" are different facts, and recording the first
   * as the second makes the merchant's reconciliation artefact wrong in exactly
   * the case where reconciliation matters. When this status is set,
   * `externalReference` carries the broadcast transaction hash so the outcome
   * can be resolved later.
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
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
