/**
 * Canonical receipt model.
 *
 * FROZEN CONTRACT.
 */
import type { AuthorizationRecord } from './authorization.js';
import type { IsoTimestamp } from './common.js';
import type { PaymentResult } from './payment.js';

export interface CommerceReceipt {
  readonly id: string;
  readonly requestId: string;
  readonly resourceId: string;
  /** Absent for free resources. */
  readonly payment?: PaymentResult;
  /**
   * Present only when the resource required one. A method and a digest, so the
   * receipt records that consent existed without storing the proof of it.
   */
  readonly authorization?: AuthorizationRecord;
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
   * State of the authorisation, as far as the gateway can prove it.
   *
   * `settlement-uncertain` is deliberately distinct from `failed`: the
   * settlement was attempted and no verdict came back (RPC timeout, dropped
   * connection, a facilitator that accepted the transfer and then lost the
   * response). "The facilitator did not answer" and "the transfer did not
   * happen" are different facts, and recording the first as the second makes
   * the merchant's reconciliation artefact wrong in exactly the case where
   * reconciliation matters. `externalReference` carries the broadcast
   * transaction hash when one is known, which is often not: the response
   * that would have carried it is usually the thing that went missing. An
   * attempt in this state is unresolved rather than terminal, and needs
   * evidence from the chain, not a retry.
   *
   * `failed` is no longer written by the execution pipeline, because a throw
   * out of settle() is never proof that nothing moved. It stays in the union
   * because existing databases hold rows recorded under the old reading.
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
