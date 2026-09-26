/**
 * The networks this gateway settles on, as data: the chain id to sign against,
 * a display name, and whether real money is involved.
 *
 * A registry rather than "parse any `eip155:*`": the chain id parses from any
 * such string, but whether it is a mainnet does not, and the guardrails key off
 * that. An unknown id is refused at startup instead of passing as a testnet.
 *
 * The local dev chain runs under Base Sepolia's `eip155:84532`, so nothing may
 * infer "public network" from the id alone. `resolveDeploymentMode` derives
 * the mode from the facilitator too, and the provider's health check confirms
 * that a local facilitator's node is Anvil.
 */
import { CommerceError } from '../../core';

/** Chain id of the local dev chain, which Base Sepolia uses too */
export const LOCAL_CHAIN_ID = 84532;

export interface NetworkProfile {
  /** CAIP-2 identifier, e.g. `eip155:84532` */
  readonly id: string;
  /** Signed into the buyer's EIP-712 domain */
  readonly chainId: number;
  readonly displayName: string;
  readonly kind: 'testnet' | 'mainnet';
  /**
   * The USDC deployment this network settles in, with the EIP-712 domain the
   * token reports. Enforced on mainnet only, since a testnet may use a mock
   * token.
   *
   * `name` is the signed EIP-712 domain name, not the symbol, and the two
   * deployments differ: `"USDC"` on Base Sepolia, `"USD Coin"` on Base. The
   * values were read back from the contracts.
   */
  readonly canonicalAsset?: {
    readonly symbol: string;
    readonly address: string;
    readonly name: string;
    readonly version: string;
  };
}

const PROFILES: readonly NetworkProfile[] = [
  {
    id: 'eip155:84532',
    chainId: 84532,
    displayName: 'Base Sepolia',
    kind: 'testnet',
    canonicalAsset: {
      symbol: 'USDC',
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      name: 'USDC',
      version: '2',
    },
  },
  {
    id: 'eip155:8453',
    chainId: 8453,
    displayName: 'Base',
    kind: 'mainnet',
    canonicalAsset: {
      symbol: 'USDC',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      name: 'USD Coin',
      version: '2',
    },
  },
];

const BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));

export const SUPPORTED_NETWORK_IDS: readonly string[] = PROFILES.map((p) => p.id);

export function findNetworkProfile(id: string): NetworkProfile | undefined {
  return BY_ID.get(id);
}

export function requireNetworkProfile(id: string, path: string): NetworkProfile {
  const profile = BY_ID.get(id);
  if (!profile) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `${path}: "${id}" is not a supported network. Supported CAIP-2 identifiers: ${SUPPORTED_NETWORK_IDS.join(', ')}`,
      { details: { path, network: id } },
    );
  }
  return profile;
}

/**
 * What a deployment is, as opposed to the network it names. `local` comes from
 * the facilitator: the in-process facilitator makes a deployment local whatever
 * CAIP-2 id it is configured with, which lets diagnostics show `eip155:84532`
 * without claiming public Base Sepolia.
 */
export type DeploymentMode = 'local' | 'testnet' | 'mainnet';

export function resolveDeploymentMode(
  profile: NetworkProfile,
  facilitatorMode: 'local' | 'remote',
): DeploymentMode {
  if (facilitatorMode === 'local') return 'local';
  return profile.kind;
}

// The banner an operator must not miss. Printed for mainnet only
const LIVE_MAINNET_BANNER = 'LIVE MAINNET MODE - REAL FUNDS';

export function describeDeploymentMode(mode: DeploymentMode): string {
  return mode === 'mainnet' ? LIVE_MAINNET_BANNER : mode.toUpperCase();
}
