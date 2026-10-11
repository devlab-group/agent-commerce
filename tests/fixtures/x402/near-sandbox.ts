/**
 * A throwaway NEAR sandbox (nearcore's `near-sandbox`) with a NEP-141 token at
 * the testnet USDC account id. LOCAL DEVELOPMENT ONLY.
 *
 * The token is the near-sdk-rs `fungible-token` example
 * (`near/near-workspaces-rs@2b72b9b`, `examples/res/fungible_token.wasm`,
 * MIT OR Apache-2.0), checked against its SHA-256 before deployment. The
 * testnet USDC id is an implicit account, whose key nobody here holds, so
 * `sandbox_patch_state` gives it a test key before the contract is deployed.
 *
 * The sandbox's random chain ID differs from the SDK's accepted
 * `near:mainnet` and `near:testnet` IDs. Tests use the testnet ID.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Account } from '@near-js/accounts';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';

export const NEAR_TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const FUNGIBLE_TOKEN_WASM = new URL('./near/fungible_token.wasm', import.meta.url);
const FUNGIBLE_TOKEN_SHA256 = 'afdb62b051a7b7222e0fc1b7e119d6921a9addd159fe531ce0801218db74d735';
const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const READY_TIMEOUT_MS = 60_000;

export interface NearTestAccount {
  readonly accountId: string;
  readonly keyPair: KeyPair;
  readonly secretKey: KeyPairString;
}

export interface NearSandbox {
  readonly rpcUrl: string;
  /** The genesis account, funded and holding a full-access key */
  readonly root: NearTestAccount;
  account(accountId: string, keyPair: KeyPair): Account;
  stop(): Promise<void>;
}

// The binary from NEAR_SANDBOX_BIN, else `near-sandbox` on PATH
function sandboxBinary(): string {
  return process.env['NEAR_SANDBOX_BIN'] ?? 'near-sandbox';
}

export function isNearSandboxAvailable(): boolean {
  return spawnSync(sandboxBinary(), ['--version']).status === 0;
}

/** One JSON-RPC call; throws on a JSON-RPC error */
export async function nearRpc<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown,
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

/** A contract view call at final finality, its result parsed as JSON */
export async function nearView<T = unknown>(
  rpcUrl: string,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await nearRpc<{ result: number[] }>(rpcUrl, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result).toString('utf8')) as T;
}

/** Base units of `token` held by `accountId`, at final finality */
export async function ftBalance(rpcUrl: string, token: string, accountId: string): Promise<bigint> {
  return BigInt(await nearView<string>(rpcUrl, token, 'ft_balance_of', { account_id: accountId }));
}

/**
 * Waits for `check` at final finality, matching the facilitator's reads.
 * Final state can lag a setup transaction's block.
 */
export async function waitForFinal(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error('NEAR sandbox state did not reach final finality in time');
}

/**
 * Starts a sandbox with RPC on `rpcPort` and its peer port at `rpcPort + 1`,
 * and waits for its first blocks
 */
export async function startNearSandbox(options: {
  readonly rpcPort: number;
}): Promise<NearSandbox> {
  const home = await mkdtemp(join(tmpdir(), 'x402-near-'));
  const binary = sandboxBinary();
  const init = spawnSync(binary, ['--home', home, 'init'], { stdio: 'pipe' });
  if (init.status !== 0) {
    await rm(home, { recursive: true, force: true });
    throw new Error(`near-sandbox init failed: ${init.stderr.toString().slice(-2000)}`);
  }
  const configPath = join(home, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.rpc.addr = `127.0.0.1:${options.rpcPort}`;
  config.network.addr = `127.0.0.1:${options.rpcPort + 1}`;
  await writeFile(configPath, JSON.stringify(config));

  const child = spawn(binary, ['--home', home, 'run'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  const exitedEarly = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) =>
      reject(new Error(`near-sandbox exited early (code ${code}):\n${stderrTail}`)),
    );
    child.once('error', (err) => reject(err));
  });

  const rpcUrl = `http://127.0.0.1:${options.rpcPort}`;
  const stop = async () => {
    await stopProcess(child);
    await rm(home, { recursive: true, force: true });
  };
  try {
    await Promise.race([waitForBlocks(rpcUrl), exitedEarly]);
  } catch (err) {
    await stop();
    throw err;
  }

  const validator = JSON.parse(await readFile(join(home, 'validator_key.json'), 'utf8')) as {
    account_id: string;
    secret_key: KeyPairString;
  };
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return {
    rpcUrl,
    root: {
      accountId: validator.account_id,
      keyPair: KeyPair.fromString(validator.secret_key),
      secretKey: validator.secret_key,
    },
    account: (accountId, keyPair) => new Account(accountId, provider, new KeyPairSigner(keyPair)),
    stop,
  };
}

/** Creates `<name>.<root>` with a fresh full-access key and `near` NEAR */
export async function createNearAccount(
  sandbox: NearSandbox,
  name: string,
  near = 10n,
): Promise<NearTestAccount> {
  const keyPair = KeyPair.fromRandom('ed25519');
  const accountId = `${name}.${sandbox.root.accountId}`;
  await sandbox
    .account(sandbox.root.accountId, sandbox.root.keyPair)
    .createAccount(accountId, keyPair.getPublicKey(), near * ONE_NEAR);
  return { accountId, keyPair, secretKey: keyPair.toString() as KeyPairString };
}

/**
 * Deploys the fungible token at the testnet USDC id with 6 decimals, its whole
 * supply held by `holder`, and registers storage for each of `registered`
 */
export async function deployUsdc(
  sandbox: NearSandbox,
  holder: string,
  supply: bigint,
  registered: readonly string[],
): Promise<void> {
  const code = await readFile(FUNGIBLE_TOKEN_WASM);
  if (createHash('sha256').update(code).digest('hex') !== FUNGIBLE_TOKEN_SHA256) {
    throw new Error('vendored fungible_token.wasm does not match its pinned SHA-256');
  }
  const root = sandbox.account(sandbox.root.accountId, sandbox.root.keyPair);
  // Funding the implicit account creates it; the patched key lets us deploy
  await root.sendMoney(NEAR_TESTNET_USDC, 10n * ONE_NEAR);
  const tokenKey = KeyPair.fromRandom('ed25519');
  await nearRpc(sandbox.rpcUrl, 'sandbox_patch_state', {
    records: [
      {
        AccessKey: {
          account_id: NEAR_TESTNET_USDC,
          public_key: tokenKey.getPublicKey().toString(),
          access_key: { nonce: 0, permission: 'FullAccess' },
        },
      },
    ],
  });
  const token = sandbox.account(NEAR_TESTNET_USDC, tokenKey);
  await token.deployContract(new Uint8Array(code));
  await token.functionCall({
    contractId: NEAR_TESTNET_USDC,
    methodName: 'new',
    args: {
      owner_id: holder,
      total_supply: supply.toString(),
      metadata: { spec: 'ft-1.0.0', name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    },
    gas: 100n * TGAS,
  });
  for (const accountId of registered) {
    await root.functionCall({
      contractId: NEAR_TESTNET_USDC,
      methodName: 'storage_deposit',
      args: { account_id: accountId },
      gas: 30n * TGAS,
      attachedDeposit: 10n ** 22n,
    });
  }
  await waitForFinal(async () => {
    for (const accountId of [holder, ...registered]) {
      const storage = await nearView(sandbox.rpcUrl, NEAR_TESTNET_USDC, 'storage_balance_of', {
        account_id: accountId,
      });
      if (storage === null) return false;
    }
    return true;
  });
}

async function waitForBlocks(rpcUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const status = await nearRpc<{ sync_info: { latest_block_height: number } }>(
        rpcUrl,
        'status',
        [],
      );
      if (status.sync_info.latest_block_height > 1) return;
    } catch {
      // Not listening yet
    }
    await sleep(250);
  }
  throw new Error(`near-sandbox at ${rpcUrl} produced no blocks in time`);
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
