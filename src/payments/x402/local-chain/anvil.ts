/**
 * Starts the deterministic local Anvil chain used by the demo and by the
 * payment unit/E2E suites: chain id 84532 — REQUIRED, because x402's
 * `getNetworkId('base-sepolia')` returns 84532 and the whole
 * point of this chain is to let the unmodified x402 SDK talk to a private
 * network under a public network's name.
 *
 * Lives in `src/payments/x402/local-chain` (not `scripts/chain`,
 * which has no `node_modules` of its own — see `deploy-engine.ts`'s header
 * comment) so both `scripts/chain/start-anvil.ts` (the CLI) and this
 * package's own test suites can import it without a `tsc` `rootDir`
 * conflict, since it uses only Node built-ins either way.
 *
 * Note on `--block-time`: an earlier revision of this chain's spec called
 * for `--block-time 0`, but the installed Anvil build (`1.1.0-nightly`)
 * rejects a zero block time ("Duration must be greater than 0"). Omitting
 * `--block-time` entirely gives Anvil's default behaviour instead — mine a
 * new block immediately for every transaction — which is the deterministic,
 * no-empty-blocks behaviour the flag was asked for in the first place, and
 * matches `docker/chain.Dockerfile`, which already omits it for the same
 * reason.
 */
import { type ChildProcess, spawn } from 'node:child_process';

export interface StartAnvilOptions {
  readonly chainId?: number;
  readonly host?: string;
  readonly port?: number;
  readonly silent?: boolean;
  /** Max time to wait for the RPC to answer before giving up. */
  readonly readyTimeoutMs?: number;
}

export interface AnvilHandle {
  readonly process: ChildProcess;
  readonly rpcUrl: string;
  readonly chainId: number;
  stop(): Promise<void>;
}

export const DEFAULT_LOCAL_CHAIN_ID = 84532;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8545;
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** Starts anvil as a child process and resolves once its RPC answers. */
export async function startAnvil(options: StartAnvilOptions = {}): Promise<AnvilHandle> {
  const chainId = options.chainId ?? DEFAULT_LOCAL_CHAIN_ID;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const silent = options.silent ?? true;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const args = ['--chain-id', String(chainId), '--host', host, '--port', String(port)];
  if (silent) args.push('--silent');

  const child = spawn('anvil', args, {
    stdio: silent ? ['ignore', 'ignore', 'pipe'] : 'inherit',
  });

  let stderrTail = '';
  if (silent) {
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
  }

  const exitedEarly = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`anvil exited early (code ${code}). stderr:\n${stderrTail}`));
    });
    child.once('error', (err) => {
      reject(
        new Error(`Failed to spawn anvil: ${err.message}. Is Foundry installed?`, { cause: err }),
      );
    });
  });

  const rpcUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  await Promise.race([waitForRpc(rpcUrl, readyTimeoutMs), exitedEarly]);

  return {
    process: child,
    rpcUrl,
    chainId,
    async stop() {
      await stopAnvil(child);
    },
  };
}

async function waitForRpc(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (response.ok) {
        const body = (await response.json()) as { result?: string };
        if (typeof body.result === 'string') return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for anvil RPC at ${rpcUrl} to answer.`, { cause: lastError });
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    // Force-kill if it doesn't exit promptly.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  });
}
