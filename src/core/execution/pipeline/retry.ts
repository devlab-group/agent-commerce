// The retry gate: a client key either unlocks a stored response or claims the purchase
import type { PaymentProvider, PaymentResult } from '../../domain/payment';
import type { CommerceReceipt } from '../../domain/receipt';
import type { DeliveredOutcome } from '../../domain/request';
import type { CommerceResource } from '../../domain/resource';
import {
  type IdempotencyClaim,
  type IdempotencyScope,
  type IdempotencyUpdate,
  PAYMENT_KEY_ENDPOINT_PREFIX,
} from '../../domain/store-records';
import { CommerceError } from '../../errors';
import type { BackendResponse } from '../../interfaces/backend';
import type { ReceiptStore } from '../../interfaces/store';
import { isRecord } from '../../is-record';
import { hasMethodGroup, type StoreGroupMethods } from '../../store-method-groups';
import { type Flow, inputDigest } from '../journal';
import { sha256Hex } from '../merchant-key';
import type { PipelineContext } from './context';

type RetryStore = ReceiptStore &
  StoreGroupMethods<'idempotency_claims'> &
  StoreGroupMethods<'response_redelivery'>;

/** Pipeline dependencies for merchant keys or response redelivery */
export interface RetrySupport {
  readonly deployment: string;
  /** Set on a resource that stores responses */
  readonly store?: RetryStore;
}

/** A presented client key and its claim data; finalize it after a successful claim */
export interface RetryTicket {
  readonly kind: 'retry';
  readonly store: RetryStore;
  readonly scope: IdempotencyScope;
  readonly fingerprint: string;
  readonly expiresAt: string;
  /** A credential: never log it, and never send it to a merchant or facilitator */
  readonly clientKey: string;
  /** Tags the claim; only this proof gets an answer before verification */
  readonly proofDigest: string;
  readonly authorizationDigest?: string;
}

export interface RetryGate {
  /**
   * Read retry state without changing the claim. For the owning proof, return
   * the stored response or refuse an unfinished claim. Otherwise, return a
   * ticket for verification, or `undefined` if redelivery is disabled or the
   * proof or key is missing.
   */
  readonly open: (
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    validInput: unknown,
    support: RetrySupport | undefined,
    pipelineStart: number,
  ) => Promise<RetryTicket | DeliveredOutcome | undefined>;
  /**
   * Claim the key after proof verification. Return `undefined` when this request
   * owns the purchase. Reuse a stored response only if the verified payer is
   * defined and matches its recorded payer, and any required authorization is
   * the one recorded with it.
   */
  readonly claim: (
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    ticket: RetryTicket,
    verification: PaymentResult,
    pipelineStart: number,
  ) => Promise<DeliveredOutcome | undefined>;
  /** Store the response or attempt to mark its claim unresolved */
  readonly finishDelivered: (
    flow: Flow,
    ticket: RetryTicket,
    verification: PaymentResult,
    response: BackendResponse,
    receipt: CommerceReceipt,
  ) => Promise<void>;
  /** Attempt to release an uncharged claim or mark a possible charge unresolved */
  readonly finishFailed: (flow: Flow, ticket: RetryTicket) => Promise<void>;
}

// The stored row's body. Of the backend's headers, it keeps only the content type
interface StoredDelivery {
  readonly proofDigest: string;
  readonly authorizationDigest?: string;
  readonly payer?: string;
  readonly contentType?: string;
  readonly body: unknown;
  readonly receiptId: string;
}

/** The longest `redelivery.retentionHours` a resource may set: one year */
export const MAX_REDELIVERY_RETENTION_HOURS = 8760;

// The delay ACP gives its own in-flight answer
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

const REFUSALS = {
  conflict: {
    reason: 'payment_identifier_conflict',
    message: 'This payment identifier belongs to another request',
  },
  'in-flight': {
    reason: 'payment_identifier_in_flight',
    message: 'A request with this payment identifier is in progress',
  },
  unresolved: {
    reason: 'payment_identifier_unresolved',
    message:
      'The earlier request with this payment identifier may have been charged and has no stored response',
  },
} as const;

type RefusedClaim = keyof typeof REFUSALS;

/**
 * Validate deployment and store support for enabled retry features.
 * Return `undefined` when both features are disabled; throw `CONFIG_INVALID`
 * for missing dependencies.
 */
export function assertRetrySupport(
  resource: CommerceResource,
  store: ReceiptStore,
  deployment: string | undefined,
  requestId?: string,
): RetrySupport | undefined {
  const { merchantKey, redelivery } = resource.idempotency ?? {};
  if (merchantKey !== true && redelivery === undefined) return undefined;
  const invalid = (message: string) =>
    new CommerceError('CONFIG_INVALID', message, {
      ...(requestId !== undefined ? { requestId } : {}),
      resourceId: resource.id,
    });
  const unsupported = (needs: string) =>
    invalid(`Resource "${resource.id}" sets idempotency, which requires ${needs}`);
  // Bound retention to one year before computing its deadline
  const hours = redelivery?.retentionHours;
  if (
    hours !== undefined &&
    !(Number.isInteger(hours) && hours >= 1 && hours <= MAX_REDELIVERY_RETENTION_HOURS)
  ) {
    throw invalid(
      `Resource "${resource.id}" sets idempotency.redelivery.retentionHours outside 1 to ${MAX_REDELIVERY_RETENTION_HOURS}`,
    );
  }
  if (deployment === undefined) throw unsupported("the pipeline's deployment option");
  if (redelivery === undefined) return { deployment };
  if (
    !hasMethodGroup(store, 'idempotency_claims') ||
    !hasMethodGroup(store, 'response_redelivery')
  ) {
    throw unsupported('a store with idempotency claims and getIdempotencyKey');
  }
  return { deployment, store };
}

export function createRetryGate(ctx: PipelineContext): RetryGate {
  const { options, safeEmit, safePersist, buildEvent } = ctx;

  async function open(
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    validInput: unknown,
    support: RetrySupport | undefined,
    pipelineStart: number,
  ): Promise<RetryTicket | DeliveredOutcome | undefined> {
    const { request } = flow;
    const retentionHours = resource.idempotency?.redelivery?.retentionHours;
    const { payment } = request;
    if (support?.store === undefined || retentionHours === undefined || payment === undefined) {
      return undefined;
    }
    const clientKey = request.retryKey ?? provider.retryKey?.({ resource, submission: payment });
    if (clientKey === undefined) return undefined;

    const fingerprint = inputDigest(validInput);
    if (fingerprint === undefined) {
      throw new CommerceError(
        'INPUT_INVALID',
        `Input for resource "${resource.id}" is not I-JSON, so a retry key cannot identify it`,
        { requestId: request.requestId, resourceId: resource.id },
      );
    }

    const { store } = support;
    const { authorization } = request;
    const ticket: RetryTicket = {
      kind: 'retry',
      store,
      scope: {
        deployment: support.deployment,
        endpoint: `${PAYMENT_KEY_ENDPOINT_PREFIX}${resource.id}`,
        key: sha256Hex(clientKey),
      },
      fingerprint,
      expiresAt: new Date(
        options.clock.now().getTime() + retentionHours * 60 * 60 * 1000,
      ).toISOString(),
      clientKey,
      proofDigest: sha256Hex(`${payment.method}:${payment.payload}`),
      ...(authorization !== undefined
        ? { authorizationDigest: sha256Hex(`${authorization.method}:${authorization.payload}`) }
        : {}),
    };

    const existing = await reading(flow, resource, () =>
      store.getIdempotencyKey(ticket.scope, fingerprint),
    );
    // Refusing an unverified proof would reveal the key's existence or input
    if (existing?.kind === 'in-flight' || existing?.kind === 'unresolved') {
      if (existing.owner !== ticket.proofDigest) return ticket;
      throw await refusal(flow, resource, provider, existing.kind);
    }
    if (existing?.kind !== 'replay') return ticket;
    const stored = readStoredDelivery(existing.body);
    return stored?.proofDigest === ticket.proofDigest && authorizes(resource, stored, ticket)
      ? redeliver(flow, resource, provider, existing.status, stored, pipelineStart)
      : ticket;
  }

  async function claim(
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    ticket: RetryTicket,
    verification: PaymentResult,
    pipelineStart: number,
  ): Promise<DeliveredOutcome | undefined> {
    const { scope, fingerprint, expiresAt, proofDigest } = ticket;
    const claimed = await reading(flow, resource, () =>
      ticket.store.claimIdempotencyKey(scope, fingerprint, expiresAt, proofDigest),
    );
    const replay = await acceptOrRefuse(flow, resource, provider, claimed);
    if (replay === undefined) return undefined;
    const stored = await storedDelivery(flow, resource, provider, replay);
    const samePayer = verification.payer !== undefined && verification.payer === stored.payer;
    if (!samePayer || !authorizes(resource, stored, ticket)) {
      throw await refusal(flow, resource, provider, 'conflict');
    }
    return redeliver(flow, resource, provider, replay.status, stored, pipelineStart);
  }

  async function finishDelivered(
    flow: Flow,
    ticket: RetryTicket,
    verification: PaymentResult,
    response: BackendResponse,
    receipt: CommerceReceipt,
  ): Promise<void> {
    const contentType = response.headers['content-type'];
    const stored: StoredDelivery = {
      proofDigest: ticket.proofDigest,
      ...(ticket.authorizationDigest !== undefined
        ? { authorizationDigest: ticket.authorizationDigest }
        : {}),
      // Record the verified buyer; settlement may name a fee payer instead
      ...(verification.payer !== undefined ? { payer: verification.payer } : {}),
      // Keep only Content-Type; never persist a backend Set-Cookie header
      ...(contentType !== undefined ? { contentType } : {}),
      body: response.body ?? null,
      receiptId: receipt.id,
    };
    // Redelivery needs the original receipt, so a failed receipt write must block completion
    const receiptSaved = !flow.persistenceFailures.includes('receipt');
    const update = { kind: 'completed', status: response.status, body: stored } as const;
    if (receiptSaved && (await write(flow, ticket, update))) return;
    if (!flow.persistenceFailures.includes('response')) flow.persistenceFailures.push('response');
    await write(flow, ticket, { kind: 'unresolved' });
  }

  async function finishFailed(flow: Flow, ticket: RetryTicket): Promise<void> {
    await write(flow, ticket, { kind: flow.chargeRisk ? 'unresolved' : 'released' });
  }

  // Record write failures without replacing a delivery or the original error
  function write(flow: Flow, ticket: RetryTicket, update: IdempotencyUpdate): Promise<boolean> {
    return safePersist(
      flow,
      () => ticket.store.updateIdempotencyKey(ticket.scope, update),
      `updateIdempotencyKey(${update.kind})`,
      'response',
    );
  }

  async function reading<T>(
    flow: Flow,
    resource: CommerceResource,
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw new CommerceError('STORAGE_ERROR', 'Payment retry state could not be read', {
        requestId: flow.request.requestId,
        resourceId: resource.id,
        cause: error,
      });
    }
  }

  // Returns a stored response to consider, or `undefined` for an open key
  async function acceptOrRefuse(
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    claimed: IdempotencyClaim | undefined,
  ): Promise<Extract<IdempotencyClaim, { kind: 'replay' }> | undefined> {
    if (claimed === undefined || claimed.kind === 'reserved') return undefined;
    if (claimed.kind === 'replay') return claimed;
    throw await refusal(flow, resource, provider, claimed.kind);
  }

  // A malformed stored response may represent a charge; refuse it as unresolved
  async function storedDelivery(
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    replay: Extract<IdempotencyClaim, { kind: 'replay' }>,
  ): Promise<StoredDelivery> {
    const stored = readStoredDelivery(replay.body);
    if (stored === undefined) throw await refusal(flow, resource, provider, 'unresolved');
    return stored;
  }

  // These 409s omit a payment challenge to avoid prompting another charge.
  // Only in-flight claims are retryable; the active request may finish on its own.
  async function refusal(
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    kind: RefusedClaim,
  ): Promise<CommerceError> {
    const { reason, message } = REFUSALS[kind];
    await safeEmit(
      buildEvent(flow, {
        type: 'payment.rejected',
        resourceId: resource.id,
        adapter: flow.request.protocol,
        paymentProvider: provider.name,
        status: 'error',
        data: { reason },
      }),
    );
    const inFlight = kind === 'in-flight';
    return new CommerceError('PAYMENT_REPLAYED', message, {
      requestId: flow.request.requestId,
      resourceId: resource.id,
      details: {
        reason,
        ...(inFlight ? { retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS } : {}),
      },
      ...(inFlight ? { retryable: true } : {}),
    });
  }

  // Writes no receipt, attempt or journal row: the original purchase holds them
  async function redeliver(
    flow: Flow,
    resource: CommerceResource,
    provider: PaymentProvider,
    status: number,
    stored: StoredDelivery,
    pipelineStart: number,
  ): Promise<DeliveredOutcome> {
    const { request } = flow;
    const receipt = await reading(flow, resource, () => options.store.getReceipt(stored.receiptId));
    if (receipt?.payment === undefined) {
      throw await refusal(flow, resource, provider, 'unresolved');
    }
    const durationMs = Math.round(options.clock.monotonicMs() - pipelineStart);
    const { transactionId } = receipt;
    await safeEmit(
      buildEvent(flow, {
        type: 'resource.delivered',
        resourceId: resource.id,
        adapter: request.protocol,
        status: 'ok',
        durationMs,
        data: {
          redelivered: true,
          ...(transactionId !== undefined ? { originalTransactionId: transactionId } : {}),
        },
      }),
    );
    return {
      kind: 'delivered',
      requestId: request.requestId,
      ...(transactionId !== undefined ? { transactionId } : {}),
      resourceId: resource.id,
      backendStatus: status,
      body: stored.body,
      headers: stored.contentType !== undefined ? { 'content-type': stored.contentType } : {},
      payment: receipt.payment,
      receipt,
      durationMs,
      redelivered: true,
    };
  }

  return { open, claim, finishDelivered, finishFailed };
}

// Match required authorization by its original bytes: the purchase consumed
// the mandate, so it cannot be verified again
function authorizes(
  resource: CommerceResource,
  stored: StoredDelivery,
  ticket: RetryTicket,
): boolean {
  if ((resource.authorization?.required.length ?? 0) === 0) return true;
  return (
    stored.authorizationDigest !== undefined &&
    stored.authorizationDigest === ticket.authorizationDigest
  );
}

function readStoredDelivery(value: unknown): StoredDelivery | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, 'body')) return undefined;
  const { proofDigest, authorizationDigest, payer, contentType, body, receiptId } = value;
  if (typeof proofDigest !== 'string' || typeof receiptId !== 'string') return undefined;
  if (authorizationDigest !== undefined && typeof authorizationDigest !== 'string') {
    return undefined;
  }
  if (payer !== undefined && typeof payer !== 'string') return undefined;
  if (contentType !== undefined && typeof contentType !== 'string') return undefined;
  return {
    proofDigest,
    ...(authorizationDigest !== undefined ? { authorizationDigest } : {}),
    ...(payer !== undefined ? { payer } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    body,
    receiptId,
  };
}
