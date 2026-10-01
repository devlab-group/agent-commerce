/**
 * Persistence boundary for receipts, events and payment attempts, implemented
 * by src/storage/receipts. Core depends only on this interface, never on
 * SQLite.
 */
import type { AdapterDescriptor, AdapterHealth } from '../domain/common';
import type { CommerceEvent } from '../domain/event';
import type { CommerceReceipt, PaymentAttempt } from '../domain/receipt';

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

export interface ReceiptStore {
  init(): Promise<void>;

  /** Append a canonical event. Must not throw into the caller's flow */
  appendEvent(event: CommerceEvent): Promise<void>;

  /**
   * Atomically claim a payment authorization before settlement: the gateway's
   * replay defense, run for every paid request. Throws
   * `CommerceError('PAYMENT_REPLAYED')` if `replayKey` was already reserved.
   */
  reservePaymentAttempt(reservation: PaymentAttemptReservation): Promise<PaymentAttempt>;

  updatePaymentAttempt(update: PaymentAttemptUpdate): Promise<void>;

  saveReceipt(receipt: CommerceReceipt): Promise<void>;
  getReceipt(id: string): Promise<CommerceReceipt | undefined>;
  listReceipts(options?: ListOptions): Promise<readonly CommerceReceipt[]>;

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
  listEvents(options?: ListOptions): Promise<readonly CommerceEvent[]>;
  listPaymentAttempts(options?: ListOptions): Promise<readonly PaymentAttempt[]>;

  readonly descriptor: AdapterDescriptor;
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}
