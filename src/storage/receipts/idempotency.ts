/**
 * Idempotency claims use the ACP store's rules and v2 columns. Keep its stored
 * state names (`in_flight`) so legacy rows can be copied without translating
 * their states.
 *
 * `completed` rows and unresolved payment retry keys expire at their retention
 * deadline; retries then follow the normal purchase flow. Unresolved ACP rows
 * block retries until an operator deletes them.
 *
 * Unfinished rows keep the claimant's `owner` tag in `body_json`; completion
 * replaces it with the response.
 */
import type Database from 'better-sqlite3';
import {
  type Clock,
  type IdempotencyClaim,
  type IdempotencyScope,
  toCommerceError,
} from '../../core';
import { PAYMENT_KEY_ENDPOINT_PREFIX } from '../../core/domain/store-records';
import { isRecord } from '../../core/is-record';
import type { StoreGroupMethods } from '../../core/store-method-groups';
import { storedIso } from './params';

interface ClaimRow {
  state: string;
  fingerprint: string;
  status: number | null;
  body_json: string | null;
  expires_at: string;
}

type IdempotencyMethods = StoreGroupMethods<'idempotency_claims'> &
  StoreGroupMethods<'response_redelivery'>;

/**
 * Match a literal, case-sensitive endpoint prefix, including `%` and `_`.
 * An empty `@prefix` matches every endpoint.
 */
export const ENDPOINT_HAS_PREFIX = 'substr(endpoint, 1, length(@prefix)) = @prefix';

const scopeParams = (scope: IdempotencyScope) => ({
  deployment: scope.deployment,
  endpoint: scope.endpoint,
  idempotency_key: scope.key,
});

// A different fingerprint conflicts in every claim state
function claimOf(row: ClaimRow, fingerprint: string): IdempotencyClaim {
  if (row.fingerprint !== fingerprint) return { kind: 'conflict' };
  const body: unknown = row.body_json === null ? null : JSON.parse(row.body_json);
  if (row.state === 'completed') return { kind: 'replay', status: row.status ?? 500, body };
  const kind = row.state === 'unresolved' ? 'unresolved' : 'in-flight';
  const owner = isRecord(body) ? body['owner'] : undefined;
  return typeof owner === 'string' ? { kind, owner } : { kind };
}

function hasExpired(row: ClaimRow, endpoint: string, now: string): boolean {
  if (row.expires_at > now) return false;
  return (
    row.state === 'completed' ||
    (row.state === 'unresolved' && endpoint.startsWith(PAYMENT_KEY_ENDPOINT_PREFIX))
  );
}

export function createIdempotencyMethods(db: Database.Database, clock: Clock): IdempotencyMethods {
  const SCOPE =
    'deployment = @deployment AND endpoint = @endpoint AND idempotency_key = @idempotency_key';
  const selectClaim = db.prepare<Record<string, unknown>, ClaimRow>(
    `SELECT state, fingerprint, status, body_json, expires_at FROM idempotency_keys WHERE ${SCOPE}`,
  );
  const insertClaim = db.prepare(
    `INSERT INTO idempotency_keys
       (deployment, endpoint, idempotency_key, fingerprint, state, body_json, created_at, expires_at)
     VALUES (@deployment, @endpoint, @idempotency_key, @fingerprint, 'in_flight', @body_json, @created_at, @expires_at)`,
  );
  // The same rule as hasExpired
  const expireFinished = db.prepare(
    `DELETE FROM idempotency_keys WHERE expires_at <= @now
       AND (state = 'completed' OR (state = 'unresolved' AND ${ENDPOINT_HAS_PREFIX}))`,
  );
  const completeClaim = db.prepare(
    `UPDATE idempotency_keys SET state = 'completed', status = @status, body_json = @body_json
      WHERE ${SCOPE}`,
  );
  const markUnresolved = db.prepare(
    `UPDATE idempotency_keys SET state = 'unresolved' WHERE ${SCOPE}`,
  );
  const deleteClaim = db.prepare(`DELETE FROM idempotency_keys WHERE ${SCOPE}`);
  const IN_FLIGHT = `state = 'in_flight' AND ${ENDPOINT_HAS_PREFIX}`;
  const releaseInFlight = db.prepare(`DELETE FROM idempotency_keys WHERE ${IN_FLIGHT}`);
  const unresolveInFlight = db.prepare(
    `UPDATE idempotency_keys SET state = 'unresolved' WHERE ${IN_FLIGHT}`,
  );

  // Sweep expired rows during the claim; no background worker is needed
  const claim = db.transaction(
    (
      scope: IdempotencyScope,
      fingerprint: string,
      expiresAt: string,
      owner: string | undefined,
    ): IdempotencyClaim => {
      const now = clock.nowIso();
      expireFinished.run({ now, prefix: PAYMENT_KEY_ENDPOINT_PREFIX });
      const existing = selectClaim.get(scopeParams(scope));
      if (existing === undefined) {
        insertClaim.run({
          ...scopeParams(scope),
          fingerprint,
          body_json: owner !== undefined ? JSON.stringify({ owner }) : null,
          created_at: now,
          expires_at: expiresAt,
        });
        return { kind: 'reserved' };
      }
      return claimOf(existing, fingerprint);
    },
  );

  return {
    async claimIdempotencyKey(scope, fingerprint, expiresAt, owner) {
      try {
        return claim.immediate(scope, fingerprint, storedIso(expiresAt, 'expiresAt'), owner);
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to claim idempotency key');
      }
    },

    async getIdempotencyKey(scope, fingerprint) {
      try {
        const existing = selectClaim.get(scopeParams(scope));
        if (existing === undefined) return undefined;
        return hasExpired(existing, scope.endpoint, clock.nowIso())
          ? undefined
          : claimOf(existing, fingerprint);
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to read idempotency key');
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

    async recoverIdempotencyKeys({ release, endpointPrefix = '' }) {
      try {
        const recover = release ? releaseInFlight : unresolveInFlight;
        return recover.run({ prefix: endpointPrefix }).changes;
      } catch (err) {
        throw toCommerceError(err, 'STORAGE_ERROR', 'Failed to recover idempotency keys');
      }
    },
  };
}
