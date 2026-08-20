/**
 * Local deterministic chain wiring.
 *
 * The x402 SDK's own `createConnectedClient(network)` / `createSigner(...)`
 * helpers resolve RPC endpoints from a hard-coded table of public networks —
 * exactly what we must never touch: the tests must stay deterministic.
 * Instead we build plain viem clients pointed at `options.rpcUrl`,
 * using a custom `Chain` object whose id is 84532 so that x402's
 * `getNetworkId('base-sepolia')` (which returns 84532) matches the chain the
 * client is actually talking to.
 *
 * The `Local` prefix on everything here describes the *chain* these clients
 * are built for, not a test-only status: `provider.ts` calls
 * `createLocalPublicClient` and `createLocalFacilitatorClient` on the real
 * settlement path, for every payment. This is not demo scaffolding that a
 * production build could drop — v0.1 settles against the deterministic local
 * chain, so this file *is* the settlement transport. Supporting a public
 * network means making `buildLocalChain`'s hardcoded `LOCAL_CHAIN_ID` a
 * parameter, not bypassing this module.
 *
 * `dev-key-guard.ts` is the boundary that keeps that arrangement safe: it
 * refuses at provider construction if a dev key or dev `payTo` is pointed at
 * anything other than a loopback/private RPC.
 */
import {
  type Account,
  type Chain,
  type Client,
  createPublicClient,
  createWalletClient,
  http,
  type PublicActions,
  type PublicClient,
  publicActions,
  type Transport,
  type WalletActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** A wallet client that can also read chain state — matches x402's `SignerWallet`. */
export type LocalFacilitatorClient = Client<
  Transport,
  Chain,
  Account,
  undefined,
  PublicActions<Transport, Chain, Account> & WalletActions<Chain, Account>
>;

/** x402's `getNetworkId('base-sepolia')`. Not a public testnet. */
export const LOCAL_CHAIN_ID = 84532;

export function buildLocalChain(rpcUrl: string): Chain {
  return {
    id: LOCAL_CHAIN_ID,
    name: 'agent-commerce-local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  } satisfies Chain;
}

/**
 * A viem `PublicClient` for the local chain — read-only, no signing capability.
 *
 * `timeoutMs`, when given, is passed straight to viem's `http()` transport,
 * which ties it to a real `AbortController` around the underlying `fetch`
 * (see viem's `utils/promise/withTimeout.js` — `signal: true`). That is a
 * genuine cancellation, unlike a bare `Promise.race` against a timer, which
 * only stops *waiting* for the request while the request itself keeps
 * running server-side. Omit it to keep viem's own default (10s).
 */
export function createLocalPublicClient(rpcUrl: string, timeoutMs?: number): PublicClient {
  return createPublicClient({
    chain: buildLocalChain(rpcUrl),
    transport: http(rpcUrl, timeoutMs !== undefined ? { timeout: timeoutMs } : undefined),
  });
}

/**
 * A viem `WalletClient` extended with public actions, for the local
 * facilitator signer only. x402's `settle()` calls `writeContract`,
 * `waitForTransactionReceipt` and `getCode` on this client — i.e. it needs
 * both `WalletActions` and `PublicActions`, matching x402's `SignerWallet`
 * type.
 *
 * LOCAL DEVELOPMENT ONLY — the private key behind this client must always be
 * an Anvil well-known development key, never a merchant or buyer key, and
 * never a production key of any kind.
 */
export function createLocalFacilitatorClient(
  rpcUrl: string,
  signerPrivateKey: `0x${string}`,
): LocalFacilitatorClient {
  const chain = buildLocalChain(rpcUrl);
  const account = privateKeyToAccount(signerPrivateKey);
  return createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  }).extend(publicActions);
}
