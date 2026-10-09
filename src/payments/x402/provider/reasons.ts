/**
 * How the provider reads a facilitator's verify and settle results: which
 * reasons are verdicts, which leave the outcome unknown, and which errors mean
 * no verdict was obtained
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { redactedErrorText } from '../../../core/errors';

// `SettleResponse.errorReason` the SDK uses for "broadcast, not confirmed"
export const SETTLEMENT_PENDING_REASON = 'settlement_pending';
/**
 * Each family's catch-all for a throw from the broadcast call, and its reason
 * for a transaction that failed on chain. Only the second carries a
 * transaction reference. A failure the SDK recognizes before the broadcast gets
 * its own reason instead. The EVM Permit2 path appends the thrown message as
 * `: <message>`. On NEAR the second is a failed inner `ft_transfer` receipt.
 */
const TRANSACTION_FAILED_REASONS = [
  'invalid_exact_evm_transaction_failed',
  'invalid_exact_svm_transaction_failed',
  'settlement_failed',
];
export const isTransactionFailedReason = (reason: string | undefined): boolean =>
  reason !== undefined &&
  TRANSACTION_FAILED_REASONS.some((known) => reason === known || reason.startsWith(`${known}:`));
/**
 * Solana outcomes that leave the payment unknown: the facilitator is already
 * settling the same transaction for another request, or it confirmed the
 * transaction but could not yet see the transfer
 */
export const UNKNOWN_OUTCOME_REASONS: ReadonlySet<string> = new Set([
  'duplicate_settlement',
  'post_settlement_transfer_not_confirmed',
]);
/**
 * Facilitator configuration and chain-read failures yield no payment verdict.
 * The NEAR SDK returns these reasons before submission; classify them as
 * provider failures rather than buyer refusals.
 */
export const NO_VERDICT_REASONS: ReadonlySet<string> = new Set([
  'unexpected_verify_error',
  'invalid_exact_near_no_relayer_configured',
  'invalid_exact_near_current_block_height_unavailable',
  'invalid_exact_near_access_key_lookup_failed',
  'invalid_exact_near_account_lookup_failed',
  'invalid_exact_near_token_account_lookup_failed',
  'invalid_exact_near_balance_check_failed',
  'invalid_exact_near_storage_check_failed',
]);
/**
 * NEAR settle failures that are verdicts. The NEAR specification leaves the
 * reason implementation-specific and the transaction empty, even after a
 * submission, so only the SDK's verification reasons, returned before it
 * submits, and a failed inner `ft_transfer` with its hash prove nothing moved.
 */
const NEAR_PRE_SUBMISSION_REASONS: ReadonlySet<string> = new Set([
  'invalid_x402_version',
  'unsupported_scheme',
  'invalid_network',
  'insufficient_funds',
  'verification_failed',
]);
export const isNearVerdict = (reason: string | undefined): boolean =>
  reason !== undefined &&
  (reason === 'settlement_failed' ||
    reason.startsWith('invalid_exact_near_') ||
    NEAR_PRE_SUBMISSION_REASONS.has(reason));
/**
 * `invalidReason`/`errorReason` are `z.string()` in the SDK schema, with no
 * length or charset bound. They reach the buyer's error, the persisted events
 * and the merchant's ledger. A remote facilitator controls these values, so
 * they are treated as untrusted input rather than diagnostic text.
 */
const MAX_REASON_LENGTH = 64;
const REASON_SHAPE = /^[a-z0-9_.-]+$/i;

export function sanitizeReason(reason: string | undefined, fallback: string): string {
  if (reason === undefined) return fallback;
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) return fallback;
  return REASON_SHAPE.test(trimmed) ? trimmed : fallback;
}

// viem wraps every failed contract call in ContractFunctionExecutionError, so
// only the cause chain can show a revert. A revert alone does not prove nothing
// moved, because viem also reports an RPC error on a send as one; settle()
// relies on the SDK throwing only before the broadcast.
export function isOnChainRevertError(err: unknown): boolean {
  return (
    err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) !== null
  );
}

/**
 * The `instanceof` checks cover what the pinned viem HTTP transport throws
 * (`HttpRequestError` for every fetch failure, including connection refused,
 * or `TimeoutError`) and what `waitForTransactionReceipt` throws when it stops
 * polling after a broadcast. Message matching is only a fallback for errors
 * outside those classes, such as a raw undici error, because message text can
 * change with any viem or undici upgrade.
 */
export function isProviderUnavailableError(err: unknown): boolean {
  if (
    err instanceof HttpRequestError ||
    err instanceof TimeoutError ||
    err instanceof WaitForTransactionReceiptTimeoutError
  ) {
    return true;
  }
  const message = redactedErrorText(err).toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('fetch failed') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('timed out') ||
    message.includes('network error')
  );
}
