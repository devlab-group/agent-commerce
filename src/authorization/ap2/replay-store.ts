/**
 * Durable record of which mandates have been spent.
 *
 * Its own table in its own file: a payment replay key is needed only until its
 * authorization's `validBefore`, after which it cannot settle, while a consumed
 * mandate must stay consumed for as long as the merchant can be asked what they
 * delivered. Hence no retention sweep, unlike the ACP idempotency store:
 * deleting a `consumed` row makes that mandate spendable again. If the table
 * ever needs bounding, archive `released` rows and leave the rest.
 *
 * Settlement and replay-state updates are separate transactions. A crash
 * between them leaves the mandate `reserved`, blocking retries until its
 * payment is resolved and the hold is updated. This favors a refused retry
 * over a possible second payment.
 */
import type { Database } from 'better-sqlite3';
import { type Logger, NOOP_LOGGER } from '../../core';
import { openSqliteDatabase } from '../../storage/sqlite';

/**
 * `released` permits another reservation; other states block reuse.
 * `uncertain` records an unknown settlement outcome and stays blocked until
 * payment resolution is followed by a consume or release update.
 */
export type Ap2AuthorizationState = 'reserved' | 'consumed' | 'released' | 'uncertain';

/**
 * A digest and a few identifiers: everything replay defense needs, and nothing
 * a leaked database would hand an attacker
 */
export interface Ap2ReservationRequest {
  /**
   * Digest of the ISSUER-SIGNED TOKEN, not of the presentation. Selective
   * disclosure gives one mandate many presentation strings, so keying on the
   * presentation would let it be spent once per disclosed subset.
   */
  readonly reference: string;
  /** `jti` of the merchant checkout JWT the mandate binds */
  readonly checkoutJti: string;
  readonly mandateIssuer: string;
  readonly checkoutIssuer: string;
  readonly resourceId: string;
  readonly requestId: string;
}

export type Ap2ReservationResult =
  | { readonly kind: 'reserved' }
  /** Already reserved, consumed or uncertain; refuse this reservation */
  | { readonly kind: 'replayed'; readonly state: Ap2AuthorizationState };

export interface Ap2ReplayStore {
  /** Atomically claim a mandate, or report that something already holds it */
  reserve(request: Ap2ReservationRequest): Ap2ReservationResult;
  /**
   * Mark the mandate permanently spent. When `requestId` is supplied, update
   * only that request's reservation, as with `release` and `markUncertain`.
   */
  consume(reference: string, requestId?: string): void;
  /** Nothing happened: hand it back so a corrected retry can use it */
  release(reference: string, requestId?: string): void;
  /** Settlement outcome unknown. Not reusable, and flagged for a human */
  markUncertain(reference: string, requestId?: string): void;
  /** Current state, for tests and diagnostics */
  stateOf(reference: string): Ap2AuthorizationState | undefined;
  close(): void;
}

export interface Ap2ReplayStoreOptions {
  /** File path, or ':memory:' for tests */
  readonly path: string;
  readonly logger?: Logger;
  /** Injectable so tests need not move the wall clock */
  readonly now?: () => number;
}

interface StateRow {
  state: string;
}

export function createAp2ReplayStore(options: Ap2ReplayStoreOptions): Ap2ReplayStore {
  const logger = options.logger ?? NOOP_LOGGER;
  const now = options.now ?? (() => Date.now());

  const db: Database = openSqliteDatabase({
    path: options.path,
    label: 'AP2 authorization database',
    logger,
  });
  migrate(db);

  const selectByReference = db.prepare<[string], StateRow>(
    'SELECT state FROM ap2_authorizations WHERE reference = ?',
  );
  // Two mandates can bind one checkout document, giving two references, so
  // the reference alone would not catch the second one
  const selectLiveByJti = db.prepare<[string, string], StateRow>(
    `SELECT state FROM ap2_authorizations
      WHERE checkout_jti = ? AND reference != ? AND state != 'released'`,
  );
  const insert = db.prepare(
    `INSERT INTO ap2_authorizations
       (reference, checkout_jti, mandate_issuer, checkout_issuer, resource_id, request_id,
        state, created_at, updated_at)
     VALUES (@reference, @checkout_jti, @mandate_issuer, @checkout_issuer, @resource_id,
             @request_id, 'reserved', @at, @at)`,
  );
  const reReserve = db.prepare(
    `UPDATE ap2_authorizations
        SET state = 'reserved', request_id = @request_id, updated_at = @at
      WHERE reference = @reference AND state = 'released'`,
  );
  // These updates leave consumed and released rows unchanged; a consumed
  // mandate must not become reusable. reserve() can claim released rows again.
  // When supplied, requestId prevents a late update from changing another
  // request's reservation.
  const transition = db.prepare(
    `UPDATE ap2_authorizations SET state = @state, updated_at = @at
      WHERE reference = @reference AND state IN ('reserved', 'uncertain')
        AND (@request_id IS NULL OR request_id = @request_id)`,
  );

  const reserveTx = db.transaction((request: Ap2ReservationRequest): Ap2ReservationResult => {
    const at = new Date(now()).toISOString();

    const existing = selectByReference.get(request.reference);
    if (existing !== undefined && existing.state !== 'released') {
      return { kind: 'replayed', state: existing.state as Ap2AuthorizationState };
    }

    // Checked for a released reference too: another mandate may have reserved
    // or spent the same checkout while this one was released
    const sameCheckout = selectLiveByJti.get(request.checkoutJti, request.reference);
    if (sameCheckout !== undefined) {
      return { kind: 'replayed', state: sameCheckout.state as Ap2AuthorizationState };
    }

    if (existing !== undefined) {
      reReserve.run({ reference: request.reference, request_id: request.requestId, at });
      return { kind: 'reserved' };
    }

    insert.run({
      reference: request.reference,
      checkout_jti: request.checkoutJti,
      mandate_issuer: request.mandateIssuer,
      checkout_issuer: request.checkoutIssuer,
      resource_id: request.resourceId,
      request_id: request.requestId,
      at,
    });
    return { kind: 'reserved' };
  });

  const move = (reference: string, state: Ap2AuthorizationState, requestId?: string): void => {
    transition.run({
      reference,
      state,
      request_id: requestId ?? null,
      at: new Date(now()).toISOString(),
    });
  };

  let closed = false;
  return {
    reserve(request) {
      return reserveTx(request);
    },
    consume(reference, requestId) {
      move(reference, 'consumed', requestId);
    },
    release(reference, requestId) {
      move(reference, 'released', requestId);
    },
    markUncertain(reference, requestId) {
      move(reference, 'uncertain', requestId);
    },
    stateOf(reference) {
      return selectByReference.get(reference)?.state as Ap2AuthorizationState | undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

// `PRAGMA user_version`, so reopening an existing file is a no-op check
function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= 1) return;
  const apply = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ap2_authorizations (
        reference        TEXT PRIMARY KEY,
        checkout_jti     TEXT NOT NULL,
        mandate_issuer   TEXT NOT NULL,
        checkout_issuer  TEXT NOT NULL,
        resource_id      TEXT NOT NULL,
        request_id       TEXT NOT NULL,
        state            TEXT NOT NULL
                         CHECK (state IN ('reserved', 'consumed', 'released', 'uncertain')),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ap2_authorizations_checkout_jti
        ON ap2_authorizations(checkout_jti);
    `);
    db.pragma('user_version = 1');
  });
  apply();
}
