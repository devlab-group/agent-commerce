/**
 * Starts the local Anvil chain for the demo and the payment test suites. The
 * chain id defaults to 84532 because the gateway advertises `eip155:84532` and
 * the buyer's signature is bound to that id.
 *
 * `--block-time` is omitted on purpose: Anvil then mines a block for each
 * transaction and none in between, and some Anvil builds reject
 * `--block-time 0`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommerceError } from '../../../core';
import { LOCAL_CHAIN_ID } from '../networks';

export interface StartAnvilOptions {
  readonly chainId?: number;
  readonly host?: string;
  readonly port?: number;
  readonly silent?: boolean;
  /** Max time to wait for the RPC to answer before giving up */
  readonly readyTimeoutMs?: number;
}

export interface AnvilHandle {
  readonly process: ChildProcess;
  readonly rpcUrl: string;
  readonly chainId: number;
  stop(): Promise<void>;
}

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8545;
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** Starts anvil as a child process and resolves once its RPC answers */
export async function startAnvil(options: StartAnvilOptions = {}): Promise<AnvilHandle> {
  const chainId = options.chainId ?? LOCAL_CHAIN_ID;
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
        // A hung probe must not run past the deadline
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (response.ok) {
        const body = (await response.json()) as { result?: string };
        if (typeof body.result === 'string') return;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw new CommerceError(
    'INTERNAL_ERROR',
    `Timed out waiting for anvil RPC at ${rpcUrl} to answer.`,
    { cause: lastError },
  );
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    // Force-kill if it doesn't exit promptly
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  });
}
