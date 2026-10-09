/**
 * Settlement evidence read from a public chain: the transaction the facilitator
 * reported, and the token movement inside it. Balances alone are not evidence,
 * since an unrelated transfer can explain a change.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { createPublicClient, erc20Abi, http, parseEventLogs } from 'viem';
import { expect } from 'vitest';
import { ftBalance, nearRpc } from '../near-sandbox';
import { associatedTokenAddress, solanaRpc } from '../solana-validator';
import type { SmokeFamily } from './targets';

/** A token transfer a settlement must contain */
export interface ExpectedTransfer {
  readonly asset: string;
  readonly from: string;
  readonly to: string;
  /** Base units */
  readonly amount: bigint;
  /** EVM transaction hash, Solana signature or NEAR outer transaction hash */
  readonly reference: string;
}

// Polls until `read` returns a value; public nodes can lag the facilitator's
async function poll<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(3_000);
  }
}

// The transaction succeeded and emitted the token's Transfer from buyer to payee
async function evmTransfer(rpcUrl: string, expected: ExpectedTransfer): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({
    hash: expected.reference as `0x${string}`,
    timeout: 180_000,
    pollingInterval: 3_000,
  });
  expect(receipt.status, `transaction ${expected.reference} reverted`).toBe('success');
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
    .filter((log) => same(log.address, expected.asset))
    .map(({ args }) => args);
  expect(
    transfers.some(
      (args) =>
        same(args.from, expected.from) &&
        same(args.to, expected.to) &&
        args.value === expected.amount,
    ),
    `no ${expected.asset} Transfer of ${expected.amount} from ${expected.from} to ${expected.to} in ${expected.reference}: ${JSON.stringify(transfers, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))}`,
  ).toBe(true);
}

interface SolanaTokenBalance {
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

// The confirmed transaction moved the mint from the buyer's to the payee's account
async function svmTransfer(rpcUrl: string, expected: ExpectedTransfer): Promise<void> {
  const tx = await poll(
    () =>
      solanaRpc<{
        meta: {
          err: unknown;
          preTokenBalances: SolanaTokenBalance[];
          postTokenBalances: SolanaTokenBalance[];
        };
      } | null>(rpcUrl, 'getTransaction', [
        expected.reference,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ]).then((result) => result ?? undefined),
    `Solana transaction ${expected.reference}`,
  );
  expect(tx.meta.err, `transaction ${expected.reference} failed`).toBeNull();
  const held = (balances: SolanaTokenBalance[], owner: string) =>
    BigInt(
      balances.find((entry) => entry.mint === expected.asset && entry.owner === owner)
        ?.uiTokenAmount.amount ?? '0',
    );
  const change = (owner: string) =>
    held(tx.meta.postTokenBalances, owner) - held(tx.meta.preTokenBalances, owner);
  expect(change(expected.to), `payee's ${expected.asset} change in ${expected.reference}`).toBe(
    expected.amount,
  );
  expect(change(expected.from), `buyer's ${expected.asset} change in ${expected.reference}`).toBe(
    -expected.amount,
  );
}

interface NearTxStatus {
  readonly final_execution_status?: string;
  readonly receipts: readonly {
    readonly receipt_id: string;
    readonly receiver_id: string;
    readonly predecessor_id: string;
    readonly receipt: {
      readonly Action?: {
        readonly actions: readonly {
          readonly FunctionCall?: { readonly method_name: string; readonly args: string };
        }[];
      };
    };
  }[];
  readonly receipts_outcome: readonly {
    readonly id: string;
    readonly outcome: { readonly status: Record<string, unknown> };
  }[];
}

// The final outer transaction carries the buyer's ft_transfer to the payee, and
// the token's receipt for it succeeded
async function nearTransfer(
  rpcUrl: string,
  expected: ExpectedTransfer,
  senders: readonly string[],
): Promise<void> {
  // The outer transaction is the relayer's, and the lookup needs its signer
  const status = await poll(
    async () => {
      for (const sender of senders) {
        const result = await nearRpc<NearTxStatus>(rpcUrl, 'EXPERIMENTAL_tx_status', {
          tx_hash: expected.reference,
          sender_account_id: sender,
          wait_until: 'FINAL',
        }).catch(() => undefined);
        if (result !== undefined) return result;
      }
      return undefined;
    },
    `NEAR transaction ${expected.reference} signed by ${senders.join(' or ')}`,
  );
  expect(status.final_execution_status).toBe('FINAL');

  const calls = status.receipts.flatMap((receipt) =>
    (receipt.receipt.Action?.actions ?? []).flatMap((action) =>
      action.FunctionCall?.method_name === 'ft_transfer'
        ? [
            {
              receipt,
              args: JSON.parse(
                Buffer.from(action.FunctionCall.args, 'base64').toString('utf8'),
              ) as Record<string, unknown>,
            },
          ]
        : [],
    ),
  );
  const call = calls.find(
    ({ receipt, args }) =>
      receipt.receiver_id === expected.asset &&
      receipt.predecessor_id === expected.from &&
      args['receiver_id'] === expected.to &&
      BigInt(String(args['amount'])) === expected.amount,
  );
  expect(
    call,
    `no ft_transfer of ${expected.amount} ${expected.asset} from ${expected.from} to ${expected.to} in ${expected.reference}`,
  ).toBeDefined();
  const outcome = status.receipts_outcome.find((entry) => entry.id === call?.receipt.receipt_id);
  expect(outcome?.outcome.status, 'the token receipt for the ft_transfer').toHaveProperty(
    'SuccessValue',
  );
}

/** Asserts from the chain alone that the settlement moved exactly the expected tokens */
export async function assertTransferOnChain(
  family: SmokeFamily,
  rpcUrl: string,
  expected: ExpectedTransfer,
  nearSenders: readonly string[] = [],
): Promise<void> {
  if (family === 'evm') return evmTransfer(rpcUrl, expected);
  if (family === 'svm') return svmTransfer(rpcUrl, expected);
  return nearTransfer(rpcUrl, expected, nearSenders);
}

/** The buyer's balance of the asset in base units, to fail early and clearly without funds */
export async function buyerBalance(
  family: SmokeFamily,
  rpcUrl: string,
  asset: string,
  buyer: string,
): Promise<bigint> {
  if (family === 'evm') {
    return createPublicClient({ transport: http(rpcUrl) }).readContract({
      address: asset as `0x${string}`,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [buyer as `0x${string}`],
    });
  }
  if (family === 'svm') {
    const account = await associatedTokenAddress(buyer, asset);
    const result = await solanaRpc<{ value: { amount: string } } | null>(
      rpcUrl,
      'getTokenAccountBalance',
      [account, { commitment: 'confirmed' }],
    ).catch(() => null);
    return BigInt(result?.value.amount ?? '0');
  }
  return ftBalance(rpcUrl, asset, buyer);
}

/**
 * A Solana transfer goes to the payee's associated token account, which the
 * SDK client does not create. Returns it when it exists.
 */
export async function solanaPayeeAccount(
  rpcUrl: string,
  asset: string,
  payTo: string,
): Promise<string | undefined> {
  const account = await associatedTokenAddress(payTo, asset);
  const info = await solanaRpc<{ value: unknown } | null>(rpcUrl, 'getAccountInfo', [
    account,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);
  return info?.value ? account : undefined;
}

/**
 * Whether the buyer signs with a full-access key. A delegated `ft_transfer`
 * attaches one yoctoNEAR, which a function-call key cannot.
 */
export async function nearFullAccessKey(
  rpcUrl: string,
  accountId: string,
  key: KeyPairString,
): Promise<boolean> {
  const access = await nearRpc<{ permission: unknown }>(rpcUrl, 'query', {
    request_type: 'view_access_key',
    finality: 'final',
    account_id: accountId,
    public_key: KeyPair.fromString(key).getPublicKey().toString(),
  }).catch(() => undefined);
  return access?.permission === 'FullAccess';
}

/** The buyer's Permit2 allowance for the token, which a Permit2 payment spends */
export async function permit2Allowance(
  rpcUrl: string,
  asset: string,
  buyer: string,
): Promise<bigint> {
  return createPublicClient({ transport: http(rpcUrl) }).readContract({
    address: asset as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [buyer as `0x${string}`, PERMIT2_ADDRESS],
  });
}
