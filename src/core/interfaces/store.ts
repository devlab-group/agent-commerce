/**
 * Persistence boundary for receipts, events and payment attempts.
 *
 * Implemented by src/storage/receipts. Core depends only on this
 * interface, never on SQLite.
 */
import type { AdapterDescriptor, AdapterHealth } from '../domain/common.js';
import type { CommerceEvent } from '../domain/event.js';
import type { CommerceReceipt, PaymentAttempt } from '../domain/receipt.js';

export interface PaymentAttemptReservation {
  readonly requestId: string;
  readonly resourceId: string;
  readonly provider: string;
  /** Must be unique across the store — see PaymentResult.replayKey. */
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

  /** Append a canonical event. Must not throw into the caller's flow. */
  appendEvent(event: CommerceEvent): Promise<void>;

  /**
   * Atomically claim a payment authorisation before settlement.
   *
   * Throws `CommerceError('PAYMENT_REPLAYED')` if `replayKey` was already
   * reserved. This is the gateway's replay defence and is required for every
   * paid request.
   */
  reservePaymentAttempt(reservation: PaymentAttemptReservation): Promise<PaymentAttempt>;

  updatePaymentAttempt(update: PaymentAttemptUpdate): Promise<void>;

  saveReceipt(receipt: CommerceReceipt): Promise<void>;
  getReceipt(id: string): Promise<CommerceReceipt | undefined>;
  listReceipts(options?: ListOptions): Promise<readonly CommerceReceipt[]>;

  /**
   * Total receipts held, ignoring any list limit.
   *
   * `listReceipts` clamps to a bounded page (a store-level invariant, so an
   * unbounded `limit` cannot dump the ledger). Counting by measuring the length
   * of a list therefore silently saturates at the clamp — `doctor` reported
   * "receipts=500" forever once 500 was passed. A diagnostic that quietly stops
   * counting is worse than one that admits it cannot.
   */
  countReceipts(): Promise<number>;

  /**
   * Receipts whose delivery did not succeed — `backendStatus` outside 2xx.
   *
   * A paid-but-undelivered purchase is the one row a merchant must notice:
   * settlement is final and this release has no refunds, so *seeing* it is the only
   * remedy available. Counted rather than listed for the same reason as
   * {@link countReceipts} — `listReceipts` is clamped, so counting by list
   * length silently saturates.
   *
   * In practice this is exactly "paid but undelivered", not "any failed
   * delivery": the pipeline only ever persists a receipt when a payment was
   * attempted (`paymentResult !== undefined`), so a free resource whose
   * backend call fails throws without writing a receipt at all — there is no
   * row for `countUndeliveredReceipts` to see. Free-resource failures are
   * therefore *not* counted here, however natural it is to read the name as
   * saying they are. Writing a receipt for a failed free delivery too would be
   * a more complete ledger, but it changes what this count means — that is
   * a product decision for after the alpha, not something to do here.
   */
  countUndeliveredReceipts(): Promise<number>;
  listEvents(options?: ListOptions): Promise<readonly CommerceEvent[]>;
  listPaymentAttempts(options?: ListOptions): Promise<readonly PaymentAttempt[]>;

  readonly descriptor: AdapterDescriptor;
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}
