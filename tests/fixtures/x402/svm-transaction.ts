/**
 * Builds a Solana `exact` payment transaction offline, in the layout the SDK
 * client produces: compute unit limit and price, a `TransferChecked` to the
 * payee's token account, and a memo. The buyer signs; the fee payer slot stays
 * empty for the facilitator. Unit tests use it where no RPC answers; the E2E
 * suites use the SDK client itself.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from '@solana/kit';
import { associatedTokenAddress, TOKEN_PROGRAM } from './solana-validator';

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// Any well-formed blockhash: nothing here reaches a cluster
export const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export interface SvmPaymentInput {
  readonly buyer: TransactionSigner;
  readonly feePayer: string;
  readonly mint: string;
  readonly payTo: string;
  readonly amount: bigint;
  readonly decimals: number;
  /** Distinguishes otherwise equal transactions, as the SDK's random memo does */
  readonly memo?: string;
}

/** The base64 wire transaction an `exact` Solana payload carries */
export async function buildSvmPayment(input: SvmPaymentInput): Promise<string> {
  const source = await associatedTokenAddress(input.buyer.address, input.mint);
  const destination = await associatedTokenAddress(input.payTo, input.mint);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(input.feePayer), tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [
          // SetComputeUnitLimit (2) and SetComputeUnitPrice (3)
          {
            programAddress: address(COMPUTE_BUDGET_PROGRAM),
            data: new Uint8Array([2, ...u32(20_000)]),
          },
          {
            programAddress: address(COMPUTE_BUDGET_PROGRAM),
            data: new Uint8Array([3, ...u64(1n)]),
          },
          // TransferChecked (12): amount, then decimals
          {
            programAddress: address(TOKEN_PROGRAM),
            accounts: [
              { address: address(source), role: AccountRole.WRITABLE },
              { address: address(input.mint), role: AccountRole.READONLY },
              { address: address(destination), role: AccountRole.WRITABLE },
              {
                address: input.buyer.address,
                role: AccountRole.READONLY_SIGNER,
                signer: input.buyer,
              },
            ],
            data: new Uint8Array([12, ...u64(input.amount), input.decimals]),
          },
          {
            programAddress: address(MEMO_PROGRAM),
            data: new TextEncoder().encode(input.memo ?? 'x402'),
          },
        ],
        tx,
      ),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(BLOCKHASH), lastValidBlockHeight: 1_000n },
        tx,
      ),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

/**
 * The same transaction with different bytes in signature slot `index`: slot
 * 0 is the fee payer's, which the facilitator overwrites when it settles
 */
export function withSignatureBytes(transaction: string, index: number, fill: number): string {
  const bytes = Buffer.from(transaction, 'base64');
  // One compact-u16 byte counts the signatures while there are fewer than 128
  bytes.fill(fill, 1 + index * 64, 1 + (index + 1) * 64);
  return bytes.toString('base64');
}
