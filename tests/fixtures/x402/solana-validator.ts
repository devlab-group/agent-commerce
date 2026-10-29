/**
 * A throwaway `solana-test-validator` with its accounts preloaded through
 * `--account`: a mint at a fixed address, token accounts holding balances, and
 * a funded fee payer. No setup transaction runs, so a test starts from known
 * state. LOCAL DEVELOPMENT ONLY.
 *
 * The validator has a genesis hash of its own, so it is not the cluster any
 * CAIP-2 id names. The x402 SDK accepts only the mainnet, devnet and testnet
 * ids, so tests run it under the devnet id.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const READY_TIMEOUT_MS = 60_000;

export interface PreloadedAccount {
  readonly address: string;
  readonly owner: string;
  readonly lamports: bigint;
  readonly data?: Uint8Array;
}

export interface SolanaValidator {
  readonly rpcUrl: string;
  stop(): Promise<void>;
}

export function isSolanaValidatorAvailable(): boolean {
  return spawnSync('solana-test-validator', ['--version']).status === 0;
}

/** The associated token account of `owner` for an SPL Token `mint` */
export async function associatedTokenAddress(owner: string, mint: string): Promise<string> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM),
    seeds: [
      encoder.encode(address(owner)),
      encoder.encode(address(TOKEN_PROGRAM)),
      encoder.encode(address(mint)),
    ],
  });
  return pda;
}

/** An initialized SPL Token mint with no mint or freeze authority */
export function mintAccount(address_: string, decimals: number, supply: bigint): PreloadedAccount {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  view.setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = 1;
  return { address: address_, owner: TOKEN_PROGRAM, lamports: LAMPORTS_PER_SOL, data };
}

/** An initialized SPL Token account holding `amount` of `mint` */
export async function tokenAccount(
  owner: string,
  mint: string,
  amount: bigint,
): Promise<PreloadedAccount> {
  const encoder = getAddressEncoder();
  const data = new Uint8Array(165);
  data.set(encoder.encode(address(mint)), 0);
  data.set(encoder.encode(address(owner)), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return {
    address: await associatedTokenAddress(owner, mint),
    owner: TOKEN_PROGRAM,
    lamports: LAMPORTS_PER_SOL,
    data,
  };
}

/** A system account holding SOL, such as a fee payer */
export function walletAccount(address_: string, sol: bigint): PreloadedAccount {
  return { address: address_, owner: SYSTEM_PROGRAM, lamports: sol * LAMPORTS_PER_SOL };
}

/**
 * Starts a validator on `rpcPort` (websocket `rpcPort + 1`) with `accounts`
 * in place. Its other ports sit just above, so two validators need RPC ports
 * at least 100 apart.
 */
export async function startSolanaValidator(options: {
  readonly rpcPort: number;
  readonly accounts: readonly PreloadedAccount[];
  /** Lower values shorten slots for finality and blockhash-expiry tests */
  readonly ticksPerSlot?: number;
}): Promise<SolanaValidator> {
  const dir = await mkdtemp(join(tmpdir(), 'x402-solana-'));
  const args = [
    '--reset',
    '--quiet',
    '--ledger',
    join(dir, 'ledger'),
    '--bind-address',
    '127.0.0.1',
    '--rpc-port',
    String(options.rpcPort),
    '--faucet-port',
    String(options.rpcPort + 2),
    '--gossip-port',
    String(options.rpcPort + 3),
    '--dynamic-port-range',
    `${options.rpcPort + 10}-${options.rpcPort + 60}`,
    ...(options.ticksPerSlot !== undefined
      ? ['--ticks-per-slot', String(options.ticksPerSlot)]
      : []),
  ];
  for (const [index, account] of options.accounts.entries()) {
    const file = join(dir, `account-${index}.json`);
    await writeFile(
      file,
      JSON.stringify({
        pubkey: account.address,
        account: {
          lamports: Number(account.lamports),
          data: [Buffer.from(account.data ?? []).toString('base64'), 'base64'],
          owner: account.owner,
          executable: false,
          rentEpoch: 0,
          space: account.data?.length ?? 0,
        },
      }),
    );
    args.push('--account', account.address, file);
  }

  const child = spawn('solana-test-validator', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  const exitedEarly = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) =>
      reject(new Error(`solana-test-validator exited early (code ${code}):\n${stderrTail}`)),
    );
    child.once('error', (err) => reject(err));
  });

  const rpcUrl = `http://127.0.0.1:${options.rpcPort}`;
  const stop = async () => {
    await stopProcess(child);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await Promise.race([waitForSlot(rpcUrl), exitedEarly]);
  } catch (err) {
    await stop();
    throw err;
  }
  return { rpcUrl, stop };
}

/** One JSON-RPC call; throws on a JSON-RPC error */
export async function solanaRpc<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** Base units held by a token account, as of the latest confirmed block */
export async function tokenBalance(rpcUrl: string, tokenAccount_: string): Promise<bigint> {
  const result = await solanaRpc<{ value: { amount: string } }>(rpcUrl, 'getTokenAccountBalance', [
    tokenAccount_,
    { commitment: 'confirmed' },
  ]);
  return BigInt(result.value.amount);
}

// Ready once a block has been produced, so a blockhash exists to sign against
async function waitForSlot(rpcUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await solanaRpc<number>(rpcUrl, 'getSlot', [{ commitment: 'confirmed' }])) > 0) return;
    } catch {
      // Not listening yet
    }
    await sleep(250);
  }
  throw new Error(`solana-test-validator at ${rpcUrl} did not produce a block in time`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  });
}
