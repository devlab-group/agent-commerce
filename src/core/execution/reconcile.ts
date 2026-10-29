/**
 * Reconciliation records chain-evidence outcomes, and manual resolution
 * records operator verdicts, through conditional payment-attempt updates.
 * Neither path settles, refunds or retries delivery.
 *
 * An `unknown` result leaves the attempt unresolved. Later runs skip resolved
 * attempts as payment candidates but can retry their pending authorization
 * holds. Both paths attempt hold updates after recording payment resolution.
 */
import type { AuthorizationProvider } from '../domain/authorization';
import type { PaymentProvider, PaymentReconciliationResult } from '../domain/payment';
import type { PaymentAttempt } from '../domain/receipt';
import type { Transaction } from '../domain/transaction';
import { CommerceError, redactedErrorText } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { Clock } from '../interfaces/runtime';
import type { ReceiptStore } from '../interfaces/store';

/** Default age threshold for reserved attempts, to reduce races with a running gateway */
export const DEFAULT_RECONCILE_MIN_AGE_MS = 15 * 60 * 1000;

// Journal page size while collecting candidates
const PAGE = 200;

const OUTCOMES: readonly string[] = ['settled', 'not-settled', 'unknown'];

export interface ReconcileRunOptions {
  readonly store: ReceiptStore;
  readonly providers: readonly PaymentProvider[];
  readonly clock: Clock;
  /** Stored with each resolution */
  readonly actor: string;
  /** Check provider evidence and report without recording resolutions */
  readonly dryRun?: boolean;
  readonly minAgeMs?: number;
  /** Maximum number of candidates to check */
  readonly limit?: number;
  /** Providers for hold updates; an omitted or empty list skips the hold scan */
  readonly authorizationProviders?: readonly AuthorizationProvider[];
  readonly logger?: Logger;
}

/** Reconciliation result for one candidate */
export interface ReconcileEntry {
  readonly attemptId: string;
  /** Absent for attempts without a journal entry */
  readonly transactionId?: string;
  readonly requestId: string;
  readonly provider: string;
  readonly status: PaymentAttempt['status'];
  readonly outcome: PaymentReconciliationResult['outcome'];
  readonly reason: string;
  /** True when this run saved the attempt's resolution */
  readonly written: boolean;
  readonly externalReference?: string;
  readonly retryAfter?: string;
}

/** Requested hold update for one resolved payment */
export interface HoldEntry {
  readonly transactionId: string;
  readonly attemptId: string;
  readonly method: string;
  /** `consumed` for a settled payment, `released` for a rejected one */
  readonly hold: 'consumed' | 'released';
  /** True when the provider call succeeded and the journal hold was recorded */
  readonly written: boolean;
  /** Why the hold was not aligned */
  readonly reason?: 'provider_not_enabled' | 'provider_error';
}

export interface ReconcileReport {
  readonly dryRun: boolean;
  readonly entries: readonly ReconcileEntry[];
  readonly holds: readonly HoldEntry[];
}

interface Candidate {
  readonly attempt: PaymentAttempt;
  readonly transactionId?: string;
  readonly locator?: Readonly<Record<string, unknown>>;
}

// The journal methods reconciliation and manual resolution need
type Journal = Required<
  Pick<
    ReceiptStore,
    | 'listTransactions'
    | 'getTransaction'
    | 'getPaymentAttempt'
    | 'resolvePaymentAttempt'
    | 'recordTransactionStep'
  >
>;

function journalOf(store: ReceiptStore): Journal {
  const {
    listTransactions,
    getTransaction,
    getPaymentAttempt,
    resolvePaymentAttempt,
    recordTransactionStep,
  } = store;
  if (
    !listTransactions ||
    !getTransaction ||
    !getPaymentAttempt ||
    !resolvePaymentAttempt ||
    !recordTransactionStep
  ) {
    throw new CommerceError('STORAGE_ERROR', 'The receipt store does not support reconciliation');
  }
  return {
    listTransactions: listTransactions.bind(store),
    getTransaction: getTransaction.bind(store),
    getPaymentAttempt: getPaymentAttempt.bind(store),
    resolvePaymentAttempt: resolvePaymentAttempt.bind(store),
    recordTransactionStep: recordTransactionStep.bind(store),
  };
}

export async function runReconcile(options: ReconcileRunOptions): Promise<ReconcileReport> {
  const { store, providers, clock, actor, logger } = options;
  const dryRun = options.dryRun === true;
  const journal = journalOf(store);

  const candidates = await collectCandidates(options, journal);
  const entries: ReconcileEntry[] = [];
  for (const { attempt, transactionId, locator } of candidates) {
    const provider = providers.find((candidate) => candidate.name === attempt.provider);
    const result = await ask(provider, attempt, locator, clock, logger);
    let written = false;
    if (!dryRun && result.outcome !== 'unknown') {
      written = await journal.resolvePaymentAttempt({
        attemptId: attempt.id,
        expectedStatus: attempt.status,
        status: result.outcome === 'settled' ? 'settled' : 'rejected',
        ...(result.outcome === 'not-settled' ? { rejectionReason: 'not_settled' } : {}),
        resolution: {
          method: 'reconcile',
          actor,
          reason: result.reason,
          at: clock.nowIso(),
          ...(result.externalReference !== undefined
            ? { externalReference: result.externalReference }
            : {}),
          ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
        },
      });
    }
    entries.push({
      attemptId: attempt.id,
      ...(transactionId !== undefined ? { transactionId } : {}),
      requestId: attempt.requestId,
      provider: attempt.provider,
      status: attempt.status,
      outcome: result.outcome,
      reason: result.reason,
      written,
      ...(result.externalReference !== undefined
        ? { externalReference: result.externalReference }
        : {}),
      ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}),
    });
  }

  const authorizationProviders = options.authorizationProviders ?? [];
  const holds: HoldEntry[] = [];
  // Scan resolved payments too, so later runs can retry pending hold updates
  // ponytail: filter by pending holds if scanning every journal page becomes costly
  let cursor: string | undefined;
  while (authorizationProviders.length > 0) {
    const page = await journal.listTransactions({
      limit: PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const transaction of page.transactions) {
      const target = holdTarget(transaction);
      if (target === undefined) continue;
      holds.push(
        dryRun
          ? holdEntry(transaction, target, false)
          : await alignHold(transaction, target, {
              journal,
              authorizationProviders,
              clock,
              logger,
            }),
      );
    }
    cursor = page.nextCursor;
    if (cursor === undefined) break;
  }
  return { dryRun, entries, holds };
}

/** Input to {@link resolveManually}; `actor` is a caller-supplied label */
export interface ManualResolveOptions {
  readonly store: ReceiptStore;
  readonly authorizationProviders: readonly AuthorizationProvider[];
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly attemptId: string;
  /** `settled` or `rejected`; anything else is `INPUT_INVALID` */
  readonly status: string;
  readonly actor: string;
  readonly reason: string;
  /** Recorded as the operator's claim without checking the chain */
  readonly externalReference?: string;
  /** Required for rejection when no valid expiry is recorded */
  readonly confirmExpired?: boolean;
}

/** Why a manual resolution was not written */
export type ManualResolveRefusal =
  | 'already_resolved'
  | 'not_resolvable'
  | 'not_expired'
  | 'expiry_unknown';

export type ManualResolveResult =
  | {
      readonly resolved: true;
      readonly attempt: PaymentAttempt;
      /** Present when the attempt's transaction holds an authorization to align */
      readonly hold?: HoldEntry;
    }
  | {
      readonly resolved: false;
      readonly refusal: ManualResolveRefusal;
      readonly message: string;
      readonly attempt: PaymentAttempt;
    };

const REFUSAL_MESSAGES: Record<ManualResolveRefusal, string> = {
  already_resolved: 'The payment attempt already has a resolution',
  not_resolvable: 'Only reserved, settlement-uncertain and failed payment attempts can be resolved',
  not_expired: 'The recorded authorization expiry is still in the future',
  expiry_unknown: 'No expiry is recorded for this authorization; confirm that it has expired',
};

// Bounds on operator-supplied text stored with the resolution
const MAX_ACTOR_LENGTH = 256;
const MAX_REASON_LENGTH = 1024;
const MAX_REFERENCE_LENGTH = 256;

const RESOLVABLE: readonly PaymentAttempt['status'][] = [
  'reserved',
  'settlement-uncertain',
  'failed',
];

/**
 * Record an operator's verdict on an unresolved payment attempt, then try to
 * update its pending authorization hold. A `rejected` verdict is refused while
 * the recorded expiry is in the future. Without a valid expiry, `confirmExpired`
 * is required. Throws `INPUT_INVALID` for invalid input and
 * `RESOURCE_NOT_FOUND` for an unknown attempt.
 */
export async function resolveManually(options: ManualResolveOptions): Promise<ManualResolveResult> {
  const { clock, logger, attemptId, status, externalReference } = options;
  if (status !== 'settled' && status !== 'rejected') {
    throw invalid('status', 'status must be "settled" or "rejected"');
  }
  const actor = requiredText(options.actor, 'actor', MAX_ACTOR_LENGTH);
  const reason = requiredText(options.reason, 'reason', MAX_REASON_LENGTH);
  if (externalReference !== undefined) {
    requiredText(externalReference, 'externalReference', MAX_REFERENCE_LENGTH);
  }
  const journal = journalOf(options.store);

  const attempt = await journal.getPaymentAttempt(attemptId);
  if (attempt === undefined) {
    throw new CommerceError('RESOURCE_NOT_FOUND', `Payment attempt "${attemptId}" was not found`);
  }
  const refuse = (refusal: ManualResolveRefusal, current = attempt): ManualResolveResult => ({
    resolved: false,
    refusal,
    message: REFUSAL_MESSAGES[refusal],
    attempt: current,
  });
  if (attempt.resolution !== undefined) return refuse('already_resolved');
  if (!RESOLVABLE.includes(attempt.status)) return refuse('not_resolvable');

  const transaction =
    attempt.transactionId !== undefined
      ? await journal.getTransaction(attempt.transactionId)
      : undefined;
  if (status === 'rejected') {
    const expiresAt = Date.parse(transaction?.payment.expiresAt ?? '');
    if (expiresAt > clock.now().getTime()) return refuse('not_expired');
    if (Number.isNaN(expiresAt) && options.confirmExpired !== true) {
      return refuse('expiry_unknown');
    }
  }

  const written = await journal.resolvePaymentAttempt({
    attemptId,
    expectedStatus: attempt.status,
    status,
    ...(status === 'rejected' ? { rejectionReason: 'not_settled' } : {}),
    resolution: {
      method: 'manual',
      actor,
      reason,
      at: clock.nowIso(),
      ...(externalReference !== undefined ? { externalReference } : {}),
    },
  });
  const current = (await journal.getPaymentAttempt(attemptId)) ?? attempt;
  // The conditional update lost a race with another attempt update
  if (!written) return refuse('already_resolved', current);

  const resolved =
    transaction !== undefined ? await journal.getTransaction(transaction.id) : undefined;
  const target = resolved !== undefined ? holdTarget(resolved) : undefined;
  const hold =
    resolved !== undefined && target !== undefined
      ? await alignHold(resolved, target, {
          journal,
          authorizationProviders: options.authorizationProviders,
          clock,
          logger,
        })
      : undefined;
  return { resolved: true, attempt: current, ...(hold !== undefined ? { hold } : {}) };
}

function requiredText(value: string, field: string, max: number): string {
  if (value.trim() === '' || value.length > max) {
    throw invalid(field, `${field} must be non-empty and at most ${max} characters`);
  }
  return value;
}

function invalid(field: string, message: string): CommerceError {
  return new CommerceError('INPUT_INVALID', message, { details: { field } });
}

// Desired state for a resolved payment's journal hold still reserved or uncertain
function holdTarget(transaction: Transaction): HoldEntry['hold'] | undefined {
  const hold = transaction.authorization?.hold;
  if (hold !== 'reserved' && hold !== 'uncertain') return undefined;
  if (transaction.payment.status === 'settled') return 'consumed';
  if (transaction.payment.status === 'rejected') return 'released';
  return undefined;
}

function holdEntry(
  transaction: Transaction,
  hold: HoldEntry['hold'],
  written: boolean,
  reason?: HoldEntry['reason'],
): HoldEntry {
  return {
    transactionId: transaction.id,
    attemptId: transaction.payment.attemptId,
    method: transaction.authorization?.method ?? '',
    hold,
    written,
    ...(reason !== undefined ? { reason } : {}),
  };
}

// Call the provider before updating the journal, so a crash can leave the
// journal hold pending. After an AP2 consume/release succeeds, repeating it
// leaves replay state unchanged; the request guard protects later reservations.
async function alignHold(
  transaction: Transaction,
  target: HoldEntry['hold'],
  deps: {
    readonly journal: Journal;
    readonly authorizationProviders: readonly AuthorizationProvider[];
    readonly clock: Clock;
    readonly logger: Logger | undefined;
  },
): Promise<HoldEntry> {
  const authorization = transaction.authorization;
  const provider = deps.authorizationProviders.find(
    (candidate) => candidate.name === authorization?.method,
  );
  if (authorization === undefined || provider === undefined) {
    return holdEntry(transaction, target, false, 'provider_not_enabled');
  }
  // Bind the update to this transaction's reserving request
  const context = { requestId: transaction.requestId, resourceId: transaction.resourceId };
  try {
    if (target === 'consumed') await provider.consume(authorization.reservationId, context);
    else await provider.release(authorization.reservationId, context);
  } catch (err) {
    deps.logger?.warn(
      { transactionId: transaction.id, method: provider.name, err: redactedErrorText(err) },
      'reconcile: authorization provider threw',
    );
    return holdEntry(transaction, target, false, 'provider_error');
  }
  await deps.journal.recordTransactionStep({
    transactionId: transaction.id,
    at: deps.clock.nowIso(),
    kind: 'hold',
    hold: target,
  });
  return holdEntry(transaction, target, true);
}

// Include uncertain and legacy `failed` attempts, plus `reserved` attempts
// whose journal entries are present and whose age meets the threshold.
// Journal rows supply locators; older attempts may have none.
async function collectCandidates(
  options: ReconcileRunOptions,
  journal: Journal,
): Promise<readonly Candidate[]> {
  const { store, clock } = options;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const minAgeMs = options.minAgeMs ?? DEFAULT_RECONCILE_MIN_AGE_MS;
  const now = clock.now().getTime();
  const eligible = (attempt: PaymentAttempt) =>
    attempt.resolution === undefined &&
    (attempt.status === 'settlement-uncertain' ||
      attempt.status === 'failed' ||
      (attempt.status === 'reserved' && now - Date.parse(attempt.createdAt) >= minAgeMs));

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await journal.listTransactions({
      unresolved: true,
      limit: PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const transaction of page.transactions) {
      if (candidates.length >= limit) return candidates;
      const { attemptId, status, locator } = transaction.payment;
      if (status !== 'settlement-uncertain' && status !== 'failed' && status !== 'reserved') {
        continue;
      }
      const attempt = await journal.getPaymentAttempt(attemptId);
      if (attempt === undefined || !eligible(attempt) || seen.has(attempt.id)) continue;
      seen.add(attempt.id);
      candidates.push({
        attempt,
        transactionId: transaction.id,
        ...(locator !== undefined ? { locator } : {}),
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  // ponytail: attempts without journal entries are capped at one page; paginate for larger legacy stores
  for (const attempt of await store.listPaymentAttempts({ uncertain: true, limit: 500 })) {
    if (candidates.length >= limit) break;
    if (attempt.transactionId !== undefined || seen.has(attempt.id) || !eligible(attempt)) continue;
    seen.add(attempt.id);
    candidates.push({ attempt });
  }
  return candidates;
}

async function ask(
  provider: PaymentProvider | undefined,
  attempt: PaymentAttempt,
  locator: Readonly<Record<string, unknown>> | undefined,
  clock: Clock,
  logger: Logger | undefined,
): Promise<PaymentReconciliationResult> {
  if (provider === undefined) return { outcome: 'unknown', reason: 'provider_not_enabled' };
  if (provider.reconcile === undefined) {
    return { outcome: 'unknown', reason: 'reconcile_unsupported' };
  }
  try {
    const result = await provider.reconcile({
      attempt,
      ...(locator !== undefined ? { locator } : {}),
      now: clock.nowIso(),
    });
    if (!OUTCOMES.includes(result.outcome) || typeof result.reason !== 'string') {
      return { outcome: 'unknown', reason: 'invalid_provider_result' };
    }
    return result;
  } catch (err) {
    logger?.warn(
      { attemptId: attempt.id, provider: attempt.provider, err: redactedErrorText(err) },
      'reconcile: provider threw',
    );
    return { outcome: 'unknown', reason: 'provider_error' };
  }
}
