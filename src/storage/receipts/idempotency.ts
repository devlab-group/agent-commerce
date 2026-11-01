/**
 * Idempotency claims use the ACP store's rules and v2 columns. Keep its stored
 * state names (`in_flight`) so legacy rows can be copied without translating
 * their states.
 *
 * Only `completed` rows expire. An unresolved row blocks retries; deleting it
 * must remain an operator's decision.
 */
import type Database from 'better-sqlite3';
import {
  type Clock,
  type IdempotencyClaim,
  type IdempotencyScope,
  type ReceiptStore,
  toCommerceError,
} from '../../core';
import { storedIso } from './params';

interface ClaimRow {
  state: string;
  fingerprint: string;
  status: number | null;
  body_json: string | null;
}

type IdempotencyMethods = Required<
  Pick<ReceiptStore, 'claimIdempotencyKey' | 'updateIdempotencyKey' | 'recoverIdempotencyKeys'>
>;

const scopeParams = (scope: IdempotencyScope) => ({
  deployment: scope.deployment,
  endpoint: scope.endpoint,
  idempotency_key: scope.key,
});

export function createIdempotencyMethods(db: Database.Database, clock: Clock): IdempotencyMethods {
  const SCOPE =
    'deployment = @deployment AND endpoint = @endpoint AND idempotency_key = @idempotency_key';
  const selectClaim = db.prepare<Record<string, unknown>, ClaimRow>(
    `SELECT state, fingerprint, status, body_json FROM idempotency_keys WHERE ${SCOPE}`,
  );
  const insertClaim = db.prepare(
    `INSERT INTO idempotency_keys
       (deployment, endpoint, idempotency_key, fingerprint, state, created_at, expires_at)
     VALUES (@deployment, @endpoint, @idempotency_key, @fingerprint, 'in_flight', @created_at, @expires_at)`,
  );
  const expireCompleted = db.prepare(
    "DELETE FROM idempotency_keys WHERE expires_at <= ? AND state = 'completed'",
  );
  const completeClaim = db.prepare(
    `UPDATE idempotency_keys SET state = 'completed', status = @status, body_json = @body_json
      WHERE ${SCOPE}`,
  );
  const markUnresolved = db.prepare(
    `UPDATE idempotency_keys SET state = 'unresolved' WHERE ${SCOPE}`,
  );
  const deleteClaim = db.prepare(`DELETE FROM idempotency_keys WHERE ${SCOPE}`);
  const releaseInFlight = db.prepare("DELETE FROM idempotency_keys WHERE state = 'in_flight'");
  const unresolveInFlight = db.prepare(
    "UPDATE idempotency_keys SET state = 'unresolved' WHERE state = 'in_flight'",
  );

  // Sweep expired completed rows during the claim; no background worker is needed
  const claim = db.transaction(
    (scope: IdempotencyScope, fingerprint: string, expiresAt: string): IdempotencyClaim => {
      const now = clock.nowIso();
      expireCompleted.run(now);
      const existing = selectClaim.get(scopeParams(scope));
      if (existing === undefined) {
        insertClaim.run({
          ...scopeParams(scope),
          fingerprint,
          created_at: now,
          expires_at: expiresAt,
        });
        return { kind: 'reserved' };
      }
      // Fingerprint first: a key reused for another body conflicts whether or
      // not the first request has finished
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (existing.state === 'unresolved') return { kind: 'unresolved' };
      if (existing.state !== 'completed') return { kind: 'in-flight' };
      return {
        kind: 'replay',
        status: existing.status ?? 500,
        body: existing.body_json === null ? null : JSON.parse(existing.body_json),
      };
    },
  );

  return {
    async claimIdempotencyKey(scope, fingerprint, expiresAt) {
      try {
        return claim.immediate(scope, fingerprint, storedIso(expiresAt, 'expiresAt'));
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to claim idempotency key');
      }
    },

    async updateIdempotencyKey(scope, update) {
      try {
        switch (update.kind) {
          case 'completed':
            completeClaim.run({
              ...scopeParams(scope),
              status: update.status,
              body_json: JSON.stringify(update.body ?? null),
            });
            break;
          case 'unresolved':
            markUnresolved.run(scopeParams(scope));
            break;
          case 'released':
            deleteClaim.run(scopeParams(scope));
            break;
        }
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to update idempotency key');
      }
    },

    async recoverIdempotencyKeys(options) {
      try {
        return (options.release ? releaseInFlight : unresolveInFlight).run().changes;
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to recover idempotency keys');
      }
    },
  };
}
