/**
 * NEAR reconciliation evidence. `settled` requires a final relayer transaction
 * containing the delegate and a successful `ft_transfer` receipt matching the
 * locator's token, receiver and amount. `not-settled` requires a final block
 * past `maxBlockHeight` with the access key's nonce below the delegate's nonce,
 * proving that the expired delegate did not execute.
 */
import {
  CommerceError,
  isCommerceError,
  type PaymentAttempt,
  type PaymentReconciliationResult,
} from '../../../core';
import { isRecord } from '../../../core/is-record';
import { unknown } from './evm';

const UINT = /^\d{1,20}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface NearLocator {
  readonly senderId: string;
  readonly publicKey: string;
  readonly nonce: bigint;
  readonly maxBlockHeight: bigint;
  readonly asset: string;
  readonly receiver: string;
  readonly amount: string;
  readonly relayers: readonly string[];
}

/**
 * Parses required NEAR transfer fields and optional relayers, or returns
 * undefined for missing required fields or malformed input
 */
export function parseNearLocator(
  locator: Readonly<Record<string, unknown>>,
): NearLocator | undefined {
  const text = (key: string) => {
    const value = locator[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const uint = (key: string) => {
    const value = text(key);
    return value !== undefined && UINT.test(value) ? value : undefined;
  };
  const [senderId, publicKey, asset, receiver] = [
    text('senderId'),
    text('publicKey'),
    text('asset'),
    text('receiver'),
  ];
  const [nonce, maxBlockHeight, amount] = [uint('nonce'), uint('maxBlockHeight'), uint('amount')];
  const relayers = locator['relayers'] ?? [];
  if (!senderId || !publicKey || !asset || !receiver || !nonce || !maxBlockHeight || !amount) {
    return undefined;
  }
  if (!Array.isArray(relayers) || !relayers.every((id) => typeof id === 'string')) {
    return undefined;
  }
  return {
    senderId,
    publicKey,
    nonce: BigInt(nonce),
    maxBlockHeight: BigInt(maxBlockHeight),
    asset,
    receiver,
    amount,
    relayers,
  };
}

export interface NearEvidenceInput {
  readonly rpc: (method: string, params: unknown) => Promise<unknown>;
  readonly network: string;
  readonly locator: NearLocator;
  readonly attempt: PaymentAttempt;
}

export async function readNearEvidence(
  input: NearEvidenceInput,
): Promise<PaymentReconciliationResult> {
  const { rpc, network, locator, attempt } = input;
  const status = await rpc('status', []);
  const chainId = isRecord(status) ? status['chain_id'] : undefined;
  const expected = network.slice('near:'.length);
  if (chainId !== expected) {
    return unknown('chain_mismatch', { chainId, expectedChainId: expected });
  }

  // Look up the outer transaction with each recorded relayer as its sender
  const reference = attempt.externalReference;
  if (reference !== undefined && TX_HASH.test(reference)) {
    for (const relayer of locator.relayers) {
      const outcome = await txStatus(rpc, reference, relayer);
      if (outcome === undefined) continue;
      if (outcome.final_execution_status !== 'FINAL') {
        return unknown('not_final', { transactionHash: reference });
      }
      if (carries(outcome, locator)) {
        return {
          outcome: 'settled',
          reason: 'transfer_final',
          externalReference: reference,
          evidence: { transactionHash: reference, relayer },
        };
      }
      break;
    }
  }

  // Read the key nonce at the same final block used for the expiry check
  const block = (await rpc('block', { finality: 'final' })) as { header?: { height?: unknown } };
  const height = block.header?.height;
  if (typeof height !== 'number' || !Number.isSafeInteger(height)) {
    throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'block returned no height');
  }
  const finality = { finalBlock: String(height) };
  let key: { nonce?: unknown; error?: unknown };
  try {
    key = (await rpc('query', {
      request_type: 'view_access_key',
      block_id: height,
      account_id: locator.senderId,
      public_key: locator.publicKey,
    })) as typeof key;
  } catch (err) {
    if (rpcErrorName(err) === 'UNKNOWN_ACCESS_KEY') return unknown('access_key_missing', finality);
    throw err;
  }
  // Treat an error string inside the query result as a missing key
  if (typeof key.error === 'string') return unknown('access_key_missing', finality);
  if (typeof key.nonce !== 'number' || !Number.isSafeInteger(key.nonce)) {
    throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'view_access_key returned no nonce');
  }
  const evidence = { keyNonce: String(key.nonce), ...finality };
  // A nonce at or above the delegate's does not identify which transaction used it
  if (BigInt(key.nonce) >= locator.nonce) return unknown('used_without_record', evidence);
  if (BigInt(height) > locator.maxBlockHeight) {
    return { outcome: 'not-settled', reason: 'expired_unused', evidence };
  }
  return unknown('not_expired', { maxBlockHeight: String(locator.maxBlockHeight), ...evidence });
}

interface TxOutcome {
  readonly final_execution_status?: string;
  readonly transaction?: {
    readonly actions?: readonly {
      readonly Delegate?: {
        readonly delegate_action?: {
          readonly sender_id?: string;
          readonly public_key?: string;
          readonly nonce?: number;
        };
      };
    }[];
  };
  readonly receipts?: readonly {
    readonly receipt_id?: string;
    readonly receiver_id?: string;
    readonly predecessor_id?: string;
    readonly receipt?: {
      readonly Action?: {
        readonly actions?: readonly {
          readonly FunctionCall?: { readonly method_name?: string; readonly args?: string };
        }[];
      };
    };
  }[];
  readonly receipts_outcome?: readonly {
    readonly id?: string;
    readonly outcome?: { readonly status?: unknown };
  }[];
}

// Return the outcome, or undefined for an unknown hash and sender pair
async function txStatus(
  rpc: NearEvidenceInput['rpc'],
  hash: string,
  sender: string,
): Promise<TxOutcome | undefined> {
  try {
    return (await rpc('EXPERIMENTAL_tx_status', {
      tx_hash: hash,
      sender_account_id: sender,
      wait_until: 'NONE',
    })) as TxOutcome;
  } catch (err) {
    if (rpcErrorName(err) === 'UNKNOWN_TRANSACTION') return undefined;
    throw err;
  }
}

// Match the delegate identity and a successful ft_transfer with the recorded terms
function carries(outcome: TxOutcome, locator: NearLocator): boolean {
  const delegated = (outcome.transaction?.actions ?? []).some((action) => {
    const delegate = action.Delegate?.delegate_action;
    return (
      delegate?.sender_id === locator.senderId &&
      delegate.public_key === locator.publicKey &&
      String(delegate.nonce) === String(locator.nonce)
    );
  });
  const succeeded = new Set(
    (outcome.receipts_outcome ?? [])
      .filter((entry) => isRecord(entry.outcome?.status) && 'SuccessValue' in entry.outcome.status)
      .map((entry) => entry.id),
  );
  const transferred = (outcome.receipts ?? []).some(
    (receipt) =>
      receipt.receiver_id === locator.asset &&
      receipt.predecessor_id === locator.senderId &&
      succeeded.has(receipt.receipt_id) &&
      (receipt.receipt?.Action?.actions ?? []).some((action) => {
        const call = action.FunctionCall;
        if (call?.method_name !== 'ft_transfer' || typeof call.args !== 'string') return false;
        const args = parseArgs(call.args);
        return args?.['receiver_id'] === locator.receiver && args['amount'] === locator.amount;
      }),
  );
  return delegated && transferred;
}

function parseArgs(base64: string): Record<string, unknown> | undefined {
  try {
    const args: unknown = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return isRecord(args) ? args : undefined;
  } catch {
    return undefined;
  }
}

// Read the node's error name from `details.rpcError.cause`, such as UNKNOWN_TRANSACTION
function rpcErrorName(err: unknown): unknown {
  const rpcError = isCommerceError(err) ? err.details?.['rpcError'] : undefined;
  return isRecord(rpcError) && isRecord(rpcError['cause']) ? rpcError['cause']['name'] : undefined;
}
