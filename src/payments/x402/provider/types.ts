// Provider options, the offers resolved from them, and the state the modules share
import type { Network } from '@x402/core/types';
import type { Clock, IdGenerator, Logger, PaymentProvider } from '../../../core';
import type { createLocalPublicClient } from '../chain';
import type { FacilitatorBinding } from '../facilitator';
import type { X402FacilitatorConfig } from '../guardrails';
import type { CustomNetworks, DeploymentMode, X402Network } from '../networks';
import type { X402AssetTransferMethod } from '../options';
import type { X402PaymentFlow } from '../payment-flow';
import type { QuoteIssuer } from './quote';

/** A single offer and the settings every offer shares */
export interface X402ProviderOptions extends X402OfferOptions {
  readonly maxTimeoutSeconds?: number;
  /**
   * When the payment settles relative to the backend call. Defaults to
   * `authorization`, the x402 default: settle only after the backend succeeds.
   * `upfront` settles before the backend call.
   */
  readonly paymentFlow?: X402PaymentFlow;
  /** Per-resource overrides of `paymentFlow`, keyed by resource id */
  readonly resourcePaymentFlows?: Readonly<Record<string, X402PaymentFlow>>;
  /**
   * The media type each resource's challenge declares as `resource.mimeType`,
   * keyed by resource id. Defaults to `application/json`.
   */
  readonly resourceMimeTypes?: Readonly<Record<string, string>>;
  /**
   * Which facilitator verifies and broadcasts. `local` runs one in this process
   * against a dev chain, and its `signerPrivateKey` pays gas there, usually
   * an Anvil well-known key (LOCAL DEVELOPMENT ONLY - DO NOT FUND). `remote`
   * calls an HTTP facilitator, and the gateway then holds no signing key.
   */
  readonly facilitator: X402FacilitatorConfig;
  /** Must be `true` before anything settles on a mainnet. Never a default */
  readonly allowMainnet?: boolean;
  /** Required on mainnet when facilitator auth is `none` */
  readonly allowUnauthenticatedFacilitator?: boolean;
  /**
   * Offer overrides by resource id, sharing the provider's facilitator and
   * settings. Each list replaces the provider's offers for that resource.
   */
  readonly resourceOffers?: Readonly<Record<string, readonly X402OfferOptions[]>>;
  /**
   * Custom EVM networks keyed by CAIP-2 ID; `network` may select one, and
   * its `kind` determines mainnet guardrails
   */
  readonly customNetworks?: CustomNetworks;
  /**
   * Experimental. Signs an ERC-8409 quote for each EVM offer when the request
   * data can be canonicalized. Use a dedicated key that holds no funds.
   * Never use a merchant's or buyer's wallet key.
   */
  readonly quote?: { readonly signerPrivateKey: string };
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/** x402 payment provider with optional public quote metadata */
export interface X402PaymentProvider extends PaymentProvider {
  /**
   * Experimental. Present when ERC-8409 quote signing is enabled.
   * Publishes the issuer address for signature checks, the request scheme and
   * the key under `PaymentRequired.extensions`.
   */
  readonly quote?: {
    readonly issuer: `0x${string}`;
    readonly requestScheme: string;
    readonly extension: string;
  };
}

/** Settlement network, token and merchant payee for one offer */
export interface X402OfferOptions {
  /**
   * CAIP-2 network identifier, e.g. `eip155:8453`. An EVM chain id it carries
   * is part of the EIP-712 domain the buyer signs, so it is read from this
   * value rather than defaulted.
   */
  readonly network: string;
  /** RPC endpoint of that network, for health checks and a local facilitator */
  readonly rpcUrl: string;
  /** ERC-20 contract or Solana mint used for settlement */
  readonly asset: string;
  /** EIP-712 domain name of the asset, e.g. 'USDC'; required for EIP-3009 */
  readonly assetName?: string;
  /** EIP-712 domain version of the asset, e.g. '2'; required for EIP-3009 */
  readonly assetVersion?: string;
  readonly assetDecimals: number;
  /**
   * Merchant-controlled settlement destination, never a gateway-owned wallet.
   * On Solana it is the wallet; the transfer goes to its token account.
   */
  readonly payTo: string;
  /**
   * EVM only: `eip3009` (the default) or `permit2`. A Permit2 buyer approves
   * the Permit2 contract for the token beforehand; the gateway never sends
   * approvals.
   */
  readonly assetTransferMethod?: X402AssetTransferMethod;
}

/**
 * Offers for each paid resource, using one facilitator. The proof selects
 * the offer the buyer pays.
 */
export interface X402MultiOfferProviderOptions
  extends Omit<X402ProviderOptions, keyof X402OfferOptions> {
  readonly offers: readonly X402OfferOptions[];
}

/** Everything one offer needs at request time, resolved and checked at startup */
export interface OfferBase {
  readonly network: Network;
  readonly assetDecimals: number;
  readonly rpcUrl: string;
  readonly rpcOrigin: string;
  readonly binding: FacilitatorBinding;
}

export interface EvmOffer extends OfferBase {
  readonly family: 'evm';
  readonly profile: Extract<X402Network, { family: 'evm' }>;
  readonly method: X402AssetTransferMethod;
  readonly asset: `0x${string}`;
  readonly assetName: string | undefined;
  readonly assetVersion: string | undefined;
  readonly payTo: `0x${string}`;
  readonly healthClient: ReturnType<typeof createLocalPublicClient>;
}

/** Always a remote facilitator: the in-process one serves only the Anvil chain */
export interface SvmOffer extends OfferBase {
  readonly family: 'svm';
  readonly profile: Extract<X402Network, { family: 'svm' }>;
  readonly asset: string;
  readonly payTo: string;
}

/** Always a remote facilitator, like Solana */
export interface NearOffer extends OfferBase {
  readonly family: 'near';
  readonly profile: Extract<X402Network, { family: 'near' }>;
  readonly asset: string;
  readonly payTo: string;
}

export type Offer = EvmOffer | SvmOffer | NearOffer;

/** What the request-time modules share, resolved once when the provider is built */
export interface ProviderContext {
  readonly options: X402ProviderOptions | X402MultiOfferProviderOptions;
  /** Every distinct offer, the provider's and its resources', for health and the descriptor */
  readonly offers: readonly Offer[];
  /** The offers a resource's challenge lists, in order */
  readonly offersFor: (resourceId: string) => readonly Offer[];
  readonly deploymentMode: DeploymentMode;
  /** The shared remote binding, when the facilitator is remote */
  readonly remoteBinding: FacilitatorBinding | undefined;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly maxTimeoutSeconds: number;
  /** Present when the provider issues ERC-8409 quotes */
  readonly quotes: QuoteIssuer | undefined;
  /** The Solana inspection module; rejects when no Solana offer is configured */
  readonly svm: () => Promise<typeof import('../svm')>;
  /** The NEAR inspection module; rejects when no NEAR offer is configured */
  readonly near: () => Promise<typeof import('../near')>;
}
