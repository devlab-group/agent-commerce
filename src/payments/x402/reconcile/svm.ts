/**
 * Solana reconciliation evidence. `settled` requires a successful finalized
 * transaction whose message hash matches the locator. A missing signature can
 * be recovered by searching a known payer's history.
 *
 * A missing match remains `unknown`, including after blockhash expiry;
 * missing evidence alone does not prove `not-settled`. The operator decides
 * how to handle unresolved attempts.
 */
import {
  CommerceError,
  type PaymentAttempt,
  type PaymentReconciliationResult,
} from '../../../core';
import { isRecord } from '../../../core/is-record';
import { unknown } from './evm';

// Allow for gateway/cluster clock skew around the attempt's creation time
const CLOCK_MARGIN_SECONDS = 900;
// Entries requested per history page
const HISTORY_PAGE = 1000;
// ponytail: return history_too_long at this page cap; consider slot-based paging for busy payers
const MAX_HISTORY_PAGES = 5;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MESSAGE_HASH = /^[A-Za-z0-9+/]{43}=$/;

export interface SvmLocator {
  readonly messageHash: string;
  readonly recentBlockhash: string;
  readonly payer: string | undefined;
}

/**
 * Parses required Solana message fields and an optional payer, or returns
 * undefined for missing required fields or malformed input
 */
export function parseSvmLocator(
  locator: Readonly<Record<string, unknown>>,
): SvmLocator | undefined {
  const { messageHash, recentBlockhash, payer } = locator;
  if (typeof messageHash !== 'string' || !MESSAGE_HASH.test(messageHash)) return undefined;
  if (!isBase58(recentBlockhash, 32, 44)) return undefined;
  if (payer !== undefined && !isBase58(payer, 32, 44)) return undefined;
  return { messageHash, recentBlockhash, payer };
}

export interface SvmEvidenceInput {
  readonly rpc: (method: string, params: unknown) => Promise<unknown>;
  readonly network: string;
  readonly locator: SvmLocator;
  readonly attempt: PaymentAttempt;
  readonly messageHashOf: (transaction: string) => string | undefined;
}

export async function readSvmEvidence(
  input: SvmEvidenceInput,
): Promise<PaymentReconciliationResult> {
  const { rpc, network, locator, attempt, messageHashOf } = input;
  const genesis = await rpc('getGenesisHash', []);
  const served = `solana:${String(genesis).slice(0, 32)}`;
  if (served !== network) {
    return unknown('chain_mismatch', { network: served, expectedNetwork: network });
  }

  // Return the slot of a successful finalized transaction with the matching message
  const carries = async (id: string): Promise<number | undefined> => {
    const landed = (await rpc('getTransaction', [
      id,
      { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    ])) as { slot?: unknown; meta?: { err?: unknown }; transaction?: unknown } | null;
    if (landed?.meta?.err !== null || typeof landed.slot !== 'number') return undefined;
    const [wire] = Array.isArray(landed.transaction) ? landed.transaction : [];
    return typeof wire === 'string' && messageHashOf(wire) === locator.messageHash
      ? landed.slot
      : undefined;
  };
  const settled = (id: string, slot: number): PaymentReconciliationResult => ({
    outcome: 'settled',
    reason: 'transfer_final',
    externalReference: id,
    evidence: { transactionId: id, slot: String(slot) },
  });

  const reference = attempt.externalReference;
  if (reference !== undefined && isBase58(reference, 64, 88)) {
    const slot = await carries(reference);
    if (slot !== undefined) return settled(reference, slot);
  }

  if (locator.payer !== undefined) {
    const createdAt = Math.floor(Date.parse(attempt.createdAt) / 1000);
    const from = createdAt - CLOCK_MARGIN_SECONDS;
    const to = createdAt + CLOCK_MARGIN_SECONDS;
    let before: string | undefined;
    // Scan newest first until entries predate the window or the page cap is reached
    search: for (let page = 0; ; page += 1) {
      if (page === MAX_HISTORY_PAGES) return unknown('history_too_long', { payer: locator.payer });
      const entries = await rpc('getSignaturesForAddress', [
        locator.payer,
        {
          commitment: 'finalized',
          limit: HISTORY_PAGE,
          ...(before !== undefined ? { before } : {}),
        },
      ]);
      if (!Array.isArray(entries)) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'getSignaturesForAddress returned no list',
        );
      }
      for (const entry of entries as {
        signature?: unknown;
        err?: unknown;
        blockTime?: unknown;
      }[]) {
        if (typeof entry.signature !== 'string') continue;
        before = entry.signature;
        const time = typeof entry.blockTime === 'number' ? entry.blockTime : undefined;
        if (time !== undefined && time < from) break search;
        if (entry.err !== null || (time !== undefined && time > to)) continue;
        const slot = await carries(entry.signature);
        if (slot !== undefined) return settled(entry.signature, slot);
      }
      if (entries.length < HISTORY_PAGE) break;
    }
  }

  // Check expiry at `confirmed` so finality lag does not make a fresh blockhash
  // look invalid
  const validity = await rpc('isBlockhashValid', [
    locator.recentBlockhash,
    { commitment: 'confirmed' },
  ]);
  const valid = isRecord(validity) ? validity['value'] : undefined;
  if (typeof valid !== 'boolean') {
    throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'isBlockhashValid returned no value');
  }
  return unknown(valid ? 'not_expired' : 'blockhash_expired', {
    payerSearched: locator.payer !== undefined,
  });
}

function isBase58(value: unknown, minLength: number, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    BASE58.test(value)
  );
}
