// Optional ReceiptStore method groups. Adapters use a store for a group only
// when all its methods are present; conformance checks that each group is
// implemented in full or omitted.
import type { ReceiptStore } from './interfaces/store';

export const STORE_METHOD_GROUPS = {
  idempotency_claims: ['claimIdempotencyKey', 'updateIdempotencyKey', 'recoverIdempotencyKeys'],
  authorization_holds: [
    'reserveAuthorizationHold',
    'transitionAuthorizationHold',
    'getAuthorizationHoldState',
    'listOrphanAuthorizationHolds',
  ],
  pending_tasks: ['putPendingTask', 'getPendingTask', 'takePendingTask'],
  // Separate from `idempotency_claims`: a store can support claims without redelivery
  response_redelivery: ['getIdempotencyKey'],
} as const satisfies Record<string, readonly (keyof ReceiptStore)[]>;

export type StoreMethodGroup = keyof typeof STORE_METHOD_GROUPS;

/** The required store methods for one group */
export type StoreGroupMethods<G extends StoreMethodGroup> = Required<
  Pick<ReceiptStore, (typeof STORE_METHOD_GROUPS)[G][number]>
>;

export function hasMethodGroup<G extends StoreMethodGroup>(
  store: ReceiptStore | undefined,
  group: G,
): store is ReceiptStore & StoreGroupMethods<G> {
  return (
    store !== undefined &&
    STORE_METHOD_GROUPS[group].every((method) => typeof store[method] === 'function')
  );
}
