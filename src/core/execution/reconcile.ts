/**
 * Reconcile unresolved payment attempts using provider-supplied chain evidence
 * and record definite outcomes with conditional updates.
 *
 * An `unknown` result leaves the attempt unresolved. Resolved attempts are
 * excluded from later runs. The run records resolutions without settling,
 * refunding or retrying delivery.
 */
import type { PaymentProvider, PaymentReconciliationResult } from '../domain/payment';
import type { PaymentAttempt } from '../domain/receipt';
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

export interface ReconcileReport {
  readonly dryRun: boolean;
  readonly entries: readonly ReconcileEntry[];
}

interface Candidate {
  readonly attempt: PaymentAttempt;
  readonly transactionId?: string;
  readonly locator?: Readonly<Record<string, unknown>>;
}

export async function runReconcile(options: ReconcileRunOptions): Promise<ReconcileReport> {
  const { store, providers, clock, actor, logger } = options;
  const dryRun = options.dryRun === true;
  const journal = {
    listTransactions: store.listTransactions?.bind(store),
    getPaymentAttempt: store.getPaymentAttempt?.bind(store),
  };
  const resolvePaymentAttempt = store.resolvePaymentAttempt?.bind(store);
  if (!journal.listTransactions || !journal.getPaymentAttempt || !resolvePaymentAttempt) {
    throw new CommerceError('STORAGE_ERROR', 'The receipt store does not support reconciliation');
  }

  const candidates = await collectCandidates(options, {
    listTransactions: journal.listTransactions,
    getPaymentAttempt: journal.getPaymentAttempt,
  });
  const entries: ReconcileEntry[] = [];
  for (const { attempt, transactionId, locator } of candidates) {
    const provider = providers.find((candidate) => candidate.name === attempt.provider);
    const result = await ask(provider, attempt, locator, clock, logger);
    let written = false;
    if (!dryRun && result.outcome !== 'unknown') {
      written = await resolvePaymentAttempt({
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
  return { dryRun, entries };
}

// Include uncertain and legacy `failed` attempts, plus `reserved` attempts
// whose journal entries are present and whose age meets the threshold.
// Journal rows supply locators; older attempts may have none.
async function collectCandidates(
  options: ReconcileRunOptions,
  journal: Required<Pick<ReceiptStore, 'listTransactions' | 'getPaymentAttempt'>>,
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
