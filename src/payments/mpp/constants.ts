/**
 * The one MPP profile this rail targets.
 *
 * MPP combines a core HTTP authentication layer, an intent, a method and
 * optional extensions. These constants identify the selected combination and
 * the exact specification revision.
 *
 * Importing this metadata does not load `mppx`.
 */

/** Upstream specification repository the pinned drafts were read from */
export const MPP_SPEC_REPOSITORY = 'https://github.com/tempoxyz/mpp-specs';

/**
 * Upstream commit the pinned drafts were read at.
 *
 * A draft's content can change without its `-00` name changing, so the name
 * alone does not identify a document; the commit does.
 */
export const MPP_SPEC_COMMIT = '806fdb8b8c92cda5c84b8660558921b6bbeef7e0';

/** The core HTTP authentication draft, the `charge` intent, and its EVM method */
export const MPP_SPEC_DRAFTS = {
  core: 'draft-httpauth-payment-00',
  intent: 'draft-payment-intent-charge-00',
  method: 'draft-evm-charge-00',
} as const;

/**
 * Minimum accepted `challengeSecret.length`. This is a configuration floor,
 * not an entropy check.
 */
export const MPP_MIN_CHALLENGE_SECRET_LENGTH = 32;

/** Exact `mppx` release the rail is pinned to */
export const MPPX_VERSION = '0.10.1';

/**
 * The pinned profile.
 *
 * `intent`, `method` and `credentialType` copy MPP wire identifiers from
 * `mppx` so this module has no peer import; tests detect drift. `assetSymbol`
 * is the pricing currency an MPP resource must use. EVM charge requests carry a
 * numeric `chainId` and token address instead.
 */
export const MPP_PROFILE = {
  intent: 'charge',
  method: 'evm',
  credentialType: 'authorization',
  assetSymbol: 'USDC',
  assetDecimals: 6,
} as const;

/** Supported CAIP-2 networks; gateway config applies the x402 mainnet guardrails */
export const MPP_NETWORKS = ['eip155:84532', 'eip155:8453'] as const;

export type MppNetwork = (typeof MPP_NETWORKS)[number];

/** Default network ID, shared by Base Sepolia and the local development chain */
export const MPP_DEFAULT_NETWORK: MppNetwork = 'eip155:84532';

export function isMppNetwork(value: string): value is MppNetwork {
  return (MPP_NETWORKS as readonly string[]).includes(value);
}

/**
 * Compact descriptor value naming the core draft, intent and method
 */
export const MPP_SUPPORTED_SPEC = `mpp/${MPP_SPEC_DRAFTS.core} intent=${MPP_PROFILE.intent} method=${MPP_PROFILE.method}`;
