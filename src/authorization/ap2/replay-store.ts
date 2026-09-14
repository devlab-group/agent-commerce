/**
 * Durable record of which mandates have been spent.
 *
 * Its own table in its own file: an x402 payment replay key expires with its
 * on-chain authorisation, while a consumed mandate must stay consumed for as
 * long as the merchant can be asked what they delivered. Hence no retention
 * sweep here, unlike the ACP idempotency store next door - deleting a
 * `consumed` row makes that mandate spendable again. If the table ever needs
 * bounding, archive `released` rows and leave the rest.
 *
 * Settlement and a local commit are not one transaction. If the process dies
 * between them the row stays `reserved` and that mandate is refused from then
 * on: a refused retry costs a round trip, the other direction costs a second
 * payment.
 */
import type { Database } from 'better-sqlite3';
import { type Logger, NOOP_LOGGER } from '../../core/index.js';
import { openSqliteDatabase } from '../../storage/sqlite.js';

/**
 * `released` is "nothing happened" and the only state a mandate can be
 * presented from again. `uncertain` is a settlement whose outcome we never
 * learned: not reusable, but findable by an operator reconciling by hand.
 */
export type Ap2AuthorizationState = 'reserved' | 'consumed' | 'released' | 'uncertain';

/**
 * A digest and a few identifiers: everything replay defence needs, and nothing
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
  /** Already reserved, consumed, or of uncertain outcome. Never re-spendable */
  | { readonly kind: 'replayed'; readonly state: Ap2AuthorizationState };

export interface Ap2ReplayStore {
  /** Atomically claim a mandate, or report that something already holds it */
  reserve(request: Ap2ReservationRequest): Ap2ReservationResult;
  /** Settlement succeeded: spend it permanently */
  consume(reference: string): void;
  /** Nothing happened: hand it back so a corrected retry can use it */
  release(reference: string): void;
  /** Settlement outcome unknown. Not reusable, and flagged for a human */
  markUncertain(reference: string): void;
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
  // Guarded on `reserved`: releasing a `consumed` row would hand back a
  // mandate whose money has already moved
  const transition = db.prepare(
    `UPDATE ap2_authorizations SET state = @state, updated_at = @at
      WHERE reference = @reference AND state = 'reserved'`,
  );

  const reserveTx = db.transaction((request: Ap2ReservationRequest): Ap2ReservationResult => {
    const at = new Date(now()).toISOString();

    const existing = selectByReference.get(request.reference);
    if (existing !== undefined) {
      if (existing.state !== 'released') {
        return { kind: 'replayed', state: existing.state as Ap2AuthorizationState };
      }
      reReserve.run({ reference: request.reference, request_id: request.requestId, at });
      return { kind: 'reserved' };
    }

    const sameCheckout = selectLiveByJti.get(request.checkoutJti, request.reference);
    if (sameCheckout !== undefined) {
      return { kind: 'replayed', state: sameCheckout.state as Ap2AuthorizationState };
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

  const move = (reference: string, state: Ap2AuthorizationState): void => {
    transition.run({ reference, state, at: new Date(now()).toISOString() });
  };

  let closed = false;
  return {
    reserve(request) {
      return reserveTx(request);
    },
    consume(reference) {
      move(reference, 'consumed');
    },
    release(reference) {
      move(reference, 'released');
    },
    markUncertain(reference) {
      move(reference, 'uncertain');
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
