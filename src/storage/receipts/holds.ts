/**
 * Authorization holds follow the AP2 replay store's reservation and transition
 * rules. There is no retention sweep: deleting a `consumed` hold would make
 * its authorization reusable.
 */
import type Database from 'better-sqlite3';
import {
  type AuthorizationHold,
  type AuthorizationHoldReservation,
  type AuthorizationHoldResult,
  type AuthorizationHoldState,
  type Clock,
  CommerceError,
  toCommerceError,
} from '../../core';
import type { StoreGroupMethods } from '../../core/store-method-groups';
import { clampListLimit, storedIso } from './params';
import { redact } from './redact';

interface HoldRow {
  reference: string;
  method: string;
  binding_reference: string;
  resource_id: string;
  request_id: string;
  state: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

type HoldMethods = StoreGroupMethods<'authorization_holds'>;

const TRANSITION_TARGETS: ReadonlySet<string> = new Set(['consumed', 'released', 'uncertain']);

/**
 * Select `reserved` holds last updated before the bound parameter whose request
 * has no current or replaced payment attempt. The pipeline reserves an attempt
 * before settlement. The orphan list and store summary share this filter.
 */
export const ORPHAN_HOLD_WHERE = `h.state = 'reserved' AND h.updated_at < ?
  AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.request_id = h.request_id)
  AND NOT EXISTS (SELECT 1 FROM payment_attempt_history p WHERE p.request_id = h.request_id)`;

function rowToHold(row: HoldRow): AuthorizationHold {
  return {
    method: row.method as AuthorizationHold['method'],
    reference: row.reference,
    bindingReference: row.binding_reference,
    resourceId: row.resource_id,
    requestId: row.request_id,
    ...(row.metadata_json !== null ? { metadata: JSON.parse(row.metadata_json) } : {}),
    state: row.state as AuthorizationHoldState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createHoldMethods(db: Database.Database, clock: Clock): HoldMethods {
  const selectHold = db.prepare<[string], HoldRow>(
    'SELECT * FROM authorization_holds WHERE reference = ?',
  );
  // Different authorizations can bind the same checkout; check the binding
  // as well as the reference
  const selectLiveBinding = db.prepare<[string, string], { state: string }>(
    `SELECT state FROM authorization_holds
      WHERE binding_reference = ? AND reference != ? AND state != 'released' LIMIT 1`,
  );
  const insertHold = db.prepare(
    `INSERT INTO authorization_holds
       (reference, method, binding_reference, resource_id, request_id, state, metadata_json, created_at, updated_at)
     VALUES (@reference, @method, @binding_reference, @resource_id, @request_id, 'reserved', @metadata_json, @at, @at)`,
  );
  const reReserveHold = db.prepare(
    `UPDATE authorization_holds
        SET state = 'reserved', method = @method, binding_reference = @binding_reference,
            resource_id = @resource_id, request_id = @request_id,
            metadata_json = @metadata_json, updated_at = @at
      WHERE reference = @reference AND state = 'released'`,
  );
  // Leave consumed and released holds unchanged. A supplied requestId must
  // match the holder, so a late update cannot change another reservation.
  const transitionHold = db.prepare(
    `UPDATE authorization_holds SET state = @state, updated_at = @at
      WHERE reference = @reference AND state IN ('reserved', 'uncertain')
        AND (@request_id IS NULL OR request_id = @request_id)`,
  );
  const listOrphans = db.prepare<[string, number], HoldRow>(
    `SELECT h.* FROM authorization_holds h WHERE ${ORPHAN_HOLD_WHERE}
      ORDER BY h.updated_at, h.reference LIMIT ?`,
  );

  const reserve = db.transaction(
    (reservation: AuthorizationHoldReservation): AuthorizationHoldResult => {
      const existing = selectHold.get(reservation.reference);
      if (existing !== undefined && existing.state !== 'released') {
        return { kind: 'replayed', state: existing.state as AuthorizationHoldState };
      }
      // Even a released reference may share a binding another authorization
      // has since claimed
      const binding = selectLiveBinding.get(reservation.bindingReference, reservation.reference);
      if (binding !== undefined) {
        return { kind: 'replayed', state: binding.state as AuthorizationHoldState };
      }
      const params = {
        reference: reservation.reference,
        method: reservation.method,
        binding_reference: reservation.bindingReference,
        resource_id: reservation.resourceId,
        request_id: reservation.requestId,
        metadata_json:
          reservation.metadata !== undefined ? JSON.stringify(redact(reservation.metadata)) : null,
        at: clock.nowIso(),
      };
      (existing !== undefined ? reReserveHold : insertHold).run(params);
      return { kind: 'reserved' };
    },
  );

  const transition = db.transaction(
    (reference: string, to: string, requestId: string | undefined): boolean => {
      const { changes } = transitionHold.run({
        reference,
        state: to,
        request_id: requestId ?? null,
        at: clock.nowIso(),
      });
      if (changes > 0) return true;
      const row = selectHold.get(reference);
      if (row === undefined) return false;
      // A release and re-reservation can hand the hold to another request;
      // acknowledge the old holder's release without touching the new one
      if (requestId !== undefined && row.request_id !== requestId) return to === 'released';
      return row.state === to;
    },
  );

  return {
    async reserveAuthorizationHold(reservation) {
      try {
        return reserve.immediate(reservation);
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to reserve authorization hold');
      }
    },

    async transitionAuthorizationHold(reference, to, requestId) {
      try {
        if (!TRANSITION_TARGETS.has(to)) {
          throw new CommerceError('STORAGE_ERROR', `Invalid authorization hold target: ${to}`);
        }
        return transition.immediate(reference, to, requestId);
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to update authorization hold');
      }
    },

    async getAuthorizationHoldState(reference) {
      return selectHold.get(reference)?.state as AuthorizationHoldState | undefined;
    },

    async listOrphanAuthorizationHolds(options) {
      const before = storedIso(options.updatedBefore, 'updatedBefore');
      return listOrphans.all(before, clampListLimit(options.limit)).map(rowToHold);
    },
  };
}
