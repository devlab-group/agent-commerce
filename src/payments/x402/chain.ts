/**
 * viem clients for the x402 provider, built on the configured `rpcUrl`. The
 * SDK uses the client it is handed, so the provider's chain calls reach no
 * other RPC.
 *
 * Despite the `Local` names, `createLocalFacilitatorClient` sits on the
 * settlement path and `createLocalPublicClient` backs `health()`. The health
 * client is built for whichever network is configured. The facilitator client
 * always uses chain id 84532: an in-process facilitator is refused on a
 * mainnet, and Base Sepolia is the registry's only testnet. Registering a
 * second testnet means building this client for the configured chain.
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
import { LOCAL_CHAIN_ID } from './networks';

/** A wallet client that can also read chain state, matching x402's `SignerWallet` */
export type LocalFacilitatorClient = Client<
  Transport,
  Chain,
  Account,
  undefined,
  PublicActions<Transport, Chain, Account> & WalletActions<Chain, Account>
>;

/** CAIP-2 identifier the local dev chain is advertised under */
export const LOCAL_NETWORK = `eip155:${LOCAL_CHAIN_ID}`;

/**
 * Chain id carried by a CAIP-2 `eip155` network identifier, or `undefined` for
 * anything else. A caller must never fall back to a default chain id, because
 * the chain id is part of the EIP-712 domain the buyer signed.
 */
export function chainIdFromCaip2(network: string): number | undefined {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match?.[1]) return undefined;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : undefined;
}

/**
 * `chainId` defaults to the local dev chain, the only chain the facilitator
 * client is built for. The health client passes the configured network's id.
 */
function buildLocalChain(rpcUrl: string, chainId: number = LOCAL_CHAIN_ID): Chain {
  return {
    id: chainId,
    name: 'agent-commerce-local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  } satisfies Chain;
}

/**
 * A read-only viem `PublicClient`.
 *
 * `timeoutMs` goes to viem's `http()` transport, which aborts the underlying
 * `fetch` when it expires rather than only abandoning the wait. Omit it to keep
 * viem's default of 10s.
 */
export function createLocalPublicClient(
  rpcUrl: string,
  timeoutMs?: number,
  chainId?: number,
): PublicClient {
  return createPublicClient({
    chain: buildLocalChain(rpcUrl, chainId),
    transport: http(rpcUrl, timeoutMs !== undefined ? { timeout: timeoutMs } : undefined),
  });
}

/**
 * A viem `WalletClient` extended with public actions, for the local
 * facilitator signer only: the SDK's settlement both writes and reads through
 * it.
 *
 * LOCAL DEVELOPMENT ONLY. The key behind it pays gas on the dev chain. It is
 * usually an Anvil well-known key, and must never be a merchant, buyer or
 * production key.
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
