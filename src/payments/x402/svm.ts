/**
 * Solana `exact` payload inspection: bounded decoding and the replay identity.
 * The provider loads this module only for a Solana offer, so an EVM-only
 * deployment never imports `@x402/svm` or `@solana/kit`.
 *
 * The facilitator checks the transaction itself: the fee payer, signatures,
 * instruction layout, mint, recipient token account and amount, and a
 * simulation. Its smart-wallet path accepts layouts the gateway could not
 * parse, so the gateway does not read the transfer.
 */
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { decodeTransactionFromPayload, transactionMessageHash } from '@x402/svm';
import { isRecord } from '../../core/is-record';
import { computeSvmReplayKey } from './replay-key';

// A Solana transaction fits a 1232-byte packet, which is 1644 base64 characters
const MAX_TRANSACTION_BASE64 = 1644;

const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * The associated token account of `owner` for `mint`, where the SDK client
 * sends a Solana `exact` payment. Its transaction cannot create the account.
 */
export async function associatedTokenAccount(
  owner: string,
  mint: string,
  tokenProgram: string,
): Promise<string> {
  const encoder = getAddressEncoder();
  const [account] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM),
    seeds: [owner, tokenProgram, mint].map((key) => encoder.encode(address(key))),
  });
  return account;
}

/**
 * Returns the Solana `exact` replay key, or an SDK refusal reason for a
 * missing, oversized or undecodable transaction.
 */
export function svmReplayKey(payload: unknown, network: string): { replayKey: string } | string {
  if (!isRecord(payload)) return 'invalid_exact_svm_payload_transaction';
  const transaction = payload['transaction'];
  if (typeof transaction !== 'string' || transaction.length > MAX_TRANSACTION_BASE64) {
    return 'invalid_exact_svm_payload_transaction';
  }
  let messageHash: string;
  try {
    messageHash = transactionMessageHash(decodeTransactionFromPayload({ transaction }));
  } catch {
    return 'invalid_exact_svm_payload_transaction_could_not_be_decoded';
  }
  return { replayKey: computeSvmReplayKey({ network, messageHash }) };
}
