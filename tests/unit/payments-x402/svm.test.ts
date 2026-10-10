import { generateKeyPairSigner } from '@solana/kit';
import { decodeTransactionFromPayload, transactionMessageHash } from '@x402/svm';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeSvmReplayKey } from '../../../src/payments/x402/replay-key';
import { associatedTokenAccount, svmReplayKey } from '../../../src/payments/x402/svm';
import { buildSvmPayment, withSignatureBytes } from '../../fixtures/x402/svm-transaction';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

let transaction: string;
let other: string;

beforeAll(async () => {
  const buyer = await generateKeyPairSigner();
  const input = {
    buyer,
    feePayer: (await generateKeyPairSigner()).address,
    mint: USDC,
    payTo: (await generateKeyPairSigner()).address,
    amount: 10_000n,
    decimals: 6,
  };
  transaction = await buildSvmPayment(input);
  other = await buildSvmPayment({ ...input, memo: 'another payment' });
});

const keyOf = (value: string, network = DEVNET) => svmReplayKey({ transaction: value }, network);

// Expected values from `findAssociatedTokenPda` in @solana-program/token and
// token-2022, the helper the SDK client uses to address the payee
describe('associatedTokenAccount', () => {
  it.each([
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'Ah4G934QoGavLuFxq3mEAqSK5WeWubrTQnoFqHKUznWW'],
    ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', '9tMS3soKEbZruwgPBFWq9T2yBgvNY48had8vxRtWiM7E'],
  ])('derives the account the SDK client pays under %s', async (tokenProgram, expected) => {
    await expect(
      associatedTokenAccount('Dupg3J9doyGhLSgjKXp6BsqpqyGJtvSyBQwwVbkBr3Sf', USDC, tokenProgram),
    ).resolves.toBe(expected);
  });
});

describe('svmReplayKey', () => {
  it('hashes the message bytes the SDK hashes, under the network', () => {
    const messageHash = transactionMessageHash(decodeTransactionFromPayload({ transaction }));
    expect(keyOf(transaction)).toEqual({
      replayKey: computeSvmReplayKey({ network: DEVNET, messageHash }),
    });
  });

  it('keeps the key when the fee payer slot or any other signature changes', () => {
    // The facilitator fills slot 0 when it settles; a resubmission with other
    // signature bytes is the same payment
    expect(keyOf(withSignatureBytes(transaction, 0, 0xab))).toEqual(keyOf(transaction));
    expect(keyOf(withSignatureBytes(transaction, 1, 0xcd))).toEqual(keyOf(transaction));
  });

  it('gives another message or another network another key', () => {
    expect(keyOf(other)).not.toEqual(keyOf(transaction));
    expect(keyOf(transaction, MAINNET)).not.toEqual(keyOf(transaction));
  });

  it('refuses a payload that is not one bounded, decodable transaction', () => {
    expect(svmReplayKey('x', DEVNET)).toBe('invalid_exact_svm_payload_transaction');
    expect(svmReplayKey({}, DEVNET)).toBe('invalid_exact_svm_payload_transaction');
    expect(keyOf('A'.repeat(1645))).toBe('invalid_exact_svm_payload_transaction');
    expect(keyOf('not base64 at all!')).toBe(
      'invalid_exact_svm_payload_transaction_could_not_be_decoded',
    );
    expect(keyOf(Buffer.from([1, 2, 3]).toString('base64'))).toBe(
      'invalid_exact_svm_payload_transaction_could_not_be_decoded',
    );
  });
});
