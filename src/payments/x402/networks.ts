/**
 * Network profiles: family, display name, environment, EVM chain ID and
 * default stablecoin. Config load rejects unknown IDs; parsing an EVM chain
 * ID cannot establish whether it is mainnet. Merchants must declare custom
 * EVM networks under `payments.x402.networks`; built-ins cannot be redeclared.
 *
 * Profiles copy SDK asset defaults to keep config load and the CLI SDK-free.
 * Tests compare each profile with the pinned SDK tables.
 *
 * The local Anvil chain has a profile of its own, `eip155:31337` (Anvil's
 * default chain id), so the network alone tells a local deployment from a
 * public one. Local health checks still require an Anvil response, because an
 * RPC endpoint can report any chain id.
 */
import { CommerceError } from '../../core';

/** Chain id of the local Anvil dev chain, Anvil's default */
export const LOCAL_CHAIN_ID = 31337;

export type X402NetworkFamily = 'evm' | 'svm' | 'tvm';

export type NetworkKind = 'testnet' | 'mainnet';

/** An EVM network the x402 provider can settle on */
export interface NetworkProfile {
  /** CAIP-2 identifier, e.g. `eip155:84532` */
  readonly id: string;
  /** Signed into the buyer's EIP-712 domain */
  readonly chainId: number;
  readonly displayName: string;
  readonly kind: NetworkKind;
  /** The local Anvil dev chain, where the in-process facilitator runs */
  readonly local?: boolean;
  /**
   * Default USDC deployment and EIP-712 domain. A public network's offers
   * settle only in it; the local chain has none and names its mock token.
   *
   * `name` is the signed EIP-712 domain name, not the symbol, and deployments
   * differ: `"USDC"` on Base Sepolia, `"USD Coin"` on Base.
   */
  readonly canonicalAsset?: {
    readonly symbol: string;
    readonly address: string;
    readonly name: string;
    readonly version: string;
    readonly decimals: number;
  };
}

interface NonEvmNetwork<F extends X402NetworkFamily> {
  readonly family: F;
  readonly id: string;
  readonly displayName: string;
  readonly kind: NetworkKind;
  /** Solana mint or TON jetton master in wire form, with no EIP-712 domain */
  readonly canonicalAsset: {
    readonly symbol: string;
    readonly address: string;
    readonly decimals: number;
  };
}

export type X402Network =
  | (NetworkProfile & { readonly family: 'evm' })
  | NonEvmNetwork<'svm'>
  | NonEvmNetwork<'tvm'>;

/** A merchant-declared EVM network, from `payments.x402.networks` */
export interface CustomNetworkDeclaration {
  readonly kind: NetworkKind;
  readonly displayName: string;
}

export type CustomNetworks = Readonly<Record<string, CustomNetworkDeclaration>>;

const usdc = (address: string, name: string) =>
  ({ symbol: 'USDC', address, name, version: '2', decimals: 6 }) as const;

const PROFILES: readonly X402Network[] = [
  {
    family: 'evm',
    id: `eip155:${LOCAL_CHAIN_ID}`,
    chainId: LOCAL_CHAIN_ID,
    displayName: 'Local Anvil',
    kind: 'testnet',
    local: true,
  },
  {
    family: 'evm',
    id: 'eip155:84532',
    chainId: 84532,
    displayName: 'Base Sepolia',
    kind: 'testnet',
    canonicalAsset: usdc('0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'USDC'),
  },
  {
    family: 'evm',
    id: 'eip155:8453',
    chainId: 8453,
    displayName: 'Base',
    kind: 'mainnet',
    canonicalAsset: usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USD Coin'),
  },
  {
    family: 'evm',
    id: 'eip155:1',
    chainId: 1,
    displayName: 'Ethereum',
    kind: 'mainnet',
    canonicalAsset: usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USD Coin'),
  },
  {
    family: 'evm',
    id: 'eip155:137',
    chainId: 137,
    displayName: 'Polygon',
    kind: 'mainnet',
    canonicalAsset: usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USD Coin'),
  },
  {
    family: 'evm',
    id: 'eip155:42161',
    chainId: 42161,
    displayName: 'Arbitrum One',
    kind: 'mainnet',
    canonicalAsset: usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USD Coin'),
  },
  {
    family: 'evm',
    id: 'eip155:421614',
    chainId: 421614,
    displayName: 'Arbitrum Sepolia',
    kind: 'testnet',
    canonicalAsset: usdc('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 'USD Coin'),
  },
  {
    family: 'evm',
    id: 'eip155:43114',
    chainId: 43114,
    displayName: 'Avalanche C-Chain',
    kind: 'mainnet',
    canonicalAsset: usdc('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USD Coin'),
  },
  {
    family: 'svm',
    id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    displayName: 'Solana',
    kind: 'mainnet',
    canonicalAsset: {
      symbol: 'USDC',
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
    },
  },
  {
    family: 'svm',
    id: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    displayName: 'Solana Devnet',
    kind: 'testnet',
    canonicalAsset: {
      symbol: 'USDC',
      address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      decimals: 6,
    },
  },
  {
    family: 'tvm',
    id: 'tvm:-239',
    displayName: 'TON',
    kind: 'mainnet',
    canonicalAsset: {
      symbol: 'USDT',
      address: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
      decimals: 6,
    },
  },
  {
    family: 'tvm',
    id: 'tvm:-3',
    displayName: 'TON Testnet',
    kind: 'testnet',
    canonicalAsset: {
      symbol: 'USDT',
      address: '0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e',
      decimals: 6,
    },
  },
];

const BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));

/** Built-in networks of every family, for tests and diagnostics */
export const BUILT_IN_NETWORKS: readonly X402Network[] = PROFILES;

/** The built-in EVM networks the x402 provider settles on without a declaration */
export const SUPPORTED_NETWORK_IDS: readonly string[] = PROFILES.filter(
  (p) => p.family === 'evm',
).map((p) => p.id);

// A chain id viem and EIP-712 can carry as a JS number
const EVM_NETWORK_ID = /^eip155:([1-9]\d{0,15})$/;

function invalid(message: string, path: string): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path } });
}

/** Built-in EVM profile for callers using the original network interface */
export function findNetworkProfile(id: string): NetworkProfile | undefined {
  const profile = BY_ID.get(id);
  return profile?.family === 'evm' ? profile : undefined;
}

/** A built-in network of any family, or a declared custom EVM network */
export function findX402Network(id: string, custom?: CustomNetworks): X402Network | undefined {
  const builtIn = BY_ID.get(id);
  if (builtIn) return builtIn;
  const declared = custom?.[id];
  const chainId = Number(EVM_NETWORK_ID.exec(id)?.[1]);
  if (!declared || !Number.isSafeInteger(chainId)) return undefined;
  return {
    family: 'evm',
    id,
    chainId,
    displayName: declared.displayName,
    kind: declared.kind,
  };
}

export function requireX402Network(id: string, path: string, custom?: CustomNetworks): X402Network {
  const network = findX402Network(id, custom);
  if (!network) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `${path}: "${id}" is not a known network. Built-in CAIP-2 identifiers: ${PROFILES.map((p) => p.id).join(', ')}. Declare another EVM network under payments.x402.networks with its kind and displayName.`,
      { details: { path, network: id } },
    );
  }
  return network;
}

/**
 * Checks `payments.x402.networks`. A declaration may add an `eip155` network
 * only: redeclaring a built-in one could relabel a mainnet as a testnet, and
 * the Solana and TON networks are fixed by their SDKs.
 */
export function validateCustomNetworks(custom: CustomNetworks, path: string): void {
  for (const id of Object.keys(custom)) {
    const at = `${path}.${id}`;
    if (BY_ID.has(id)) {
      throw invalid(
        `${at}: "${id}" is a built-in network and cannot be redeclared; remove this entry`,
        at,
      );
    }
    if (!findX402Network(id, custom)) {
      throw invalid(
        `${at}: "${id}" is not an EVM CAIP-2 identifier ("eip155:" followed by a positive chain id below 2^53). Only EVM networks can be declared.`,
        at,
      );
    }
  }
}

/** What a deployment is: the local dev chain, or a public testnet or mainnet */
export type DeploymentMode = 'local' | 'testnet' | 'mainnet';

export function resolveDeploymentMode(profile: {
  readonly kind: NetworkKind;
  readonly local?: boolean;
}): DeploymentMode {
  return profile.local ? 'local' : profile.kind;
}

// The banner an operator must not miss. Printed for mainnet only
const LIVE_MAINNET_BANNER = 'LIVE MAINNET MODE - REAL FUNDS';

export function describeDeploymentMode(mode: DeploymentMode): string {
  return mode === 'mainnet' ? LIVE_MAINNET_BANNER : mode.toUpperCase();
}
