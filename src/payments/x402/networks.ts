/**
 * The networks this gateway will settle on, as data.
 *
 * x402 v2 identifies a network by its CAIP-2 id, so the only thing an
 * operator has to change to move between environments is that string. What
 * the code needs on top of it — the chain id to sign against, a name a human
 * recognises, and whether real money is involved — lives here rather than
 * being derived at each call site.
 *
 * A registry rather than "parse any `eip155:*`" on purpose. The chain id is
 * parseable from any such string, but `mainnet` is not, and every guardrail in
 * `guardrails.ts` keys off it. An unknown id is refused at startup instead of
 * being quietly treated as a testnet.
 *
 * Base Sepolia and the local dev chain share the id `eip155:84532`: the local
 * chain deliberately reuses Base Sepolia's chain id so the unmodified x402 SDK
 * can talk to it. Nothing may infer "public network" from the network id alone
 * — that is what `resolveDeploymentMode` and the Anvil probe in `provider.ts`
 * are for.
 */
import { CommerceError } from '../../core/index.js';

export interface NetworkProfile {
  /** CAIP-2 identifier, e.g. `eip155:84532`. */
  readonly id: string;
  /** Signed into the buyer's EIP-712 domain. */
  readonly chainId: number;
  readonly displayName: string;
  readonly kind: 'testnet' | 'mainnet';
  /**
   * The USDC deployment this network is expected to settle in, with the EIP-712
   * domain the token actually reports. Enforced only on mainnet (see
   * `guardrails.ts`) — a testnet is where a mock token is a legitimate thing to
   * point at.
   *
   * `name` is not decorative and is not the symbol: it is signed into every
   * buyer's EIP-712 domain, and the two USDC deployments disagree. Base Sepolia
   * reports `"USDC"`; Base mainnet reports `"USD Coin"`. Configure the wrong
   * one and every payment is refused `invalid_exact_evm_token_name_mismatch`
   * after the buyer has signed. Read back from the contracts, not assumed.
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
 * What this deployment actually is, as opposed to what it is called.
 *
 * `local` is a property of the *facilitator*, not the network: settling
 * through the in-process facilitator against a dev node is local regardless of
 * the CAIP-2 id that node answers to. This distinction is the whole reason
 * diagnostics can say `eip155:84532` without claiming to be on public Base
 * Sepolia.
 */
export type DeploymentMode = 'local' | 'testnet' | 'mainnet';

export function resolveDeploymentMode(
  profile: NetworkProfile,
  facilitatorMode: 'local' | 'remote',
): DeploymentMode {
  if (facilitatorMode === 'local') return 'local';
  return profile.kind;
}

/** The banner an operator must not be able to miss. Never printed for anything else. */
export const LIVE_MAINNET_BANNER = 'LIVE MAINNET MODE — REAL FUNDS';

export function describeDeploymentMode(mode: DeploymentMode): string {
  return mode === 'mainnet' ? LIVE_MAINNET_BANNER : mode.toUpperCase();
}
