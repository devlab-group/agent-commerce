/**
 * x402 payment provider: protocol v2, `exact` scheme. On EVM the buyer signs an
 * EIP-3009 `transferWithAuthorization` or a Permit2 transfer through the x402
 * exact proxy; on Solana, a token transfer whose fee the facilitator pays; on
 * NEAR, a delegated NEP-141 `ft_transfer` that the facilitator's relayer
 * submits.
 *
 * `verify()` never moves funds. `settle()` does, and throws unless it is handed
 * a successful verification. Both run through a facilitator (see
 * `facilitator.ts`): the SDK's own `x402Facilitator` in this process, or a
 * remote HTTP facilitator.
 */

import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from '@x402/evm';
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  getAddress,
  HttpRequestError,
  isAddress,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type Clock,
  CommerceError,
  type IdGenerator,
  type Logger,
  NOOP_LOGGER,
  type PaymentContext,
  type PaymentProvider,
  type PaymentRequirement,
  type PaymentResult,
  type PaymentSettlementContext,
  type PaymentVerificationContext,
  systemClock,
} from '../../core';
import { redactedErrorText } from '../../core/errors';
import {
  REUSE_REJECTED_AUTHORIZATION_METADATA_KEY,
  SETTLE_AFTER_BACKEND_METADATA_KEY,
} from '../../core/execution/settlement-order';
import { isRecord } from '../../core/is-record';
import { PACKAGE_VERSION } from '../../version';
import { isTransactionReference, normalizeAddress, sameAddress } from './addresses';
import { parseCanonicalAmount } from './amount';
import {
  createLocalFacilitatorClient,
  createLocalPublicClient,
  type LocalFacilitatorClient,
} from './chain';
import { assertDevKeyIsLocalOnly, assertPayToIsNotDevAddress, describeRpc } from './dev-key-guard';
import { createRemoteFacilitatorBinding, type FacilitatorBinding } from './facilitator';
import { resolveX402Deployment, type X402FacilitatorConfig } from './guardrails';
import { createLocalFacilitatorBinding } from './local-facilitator';
import {
  type CustomNetworks,
  type DeploymentMode,
  describeDeploymentMode,
  findX402Network,
  type X402Network,
} from './networks';
import type { X402AssetTransferMethod } from './options';
import {
  declaredX402Version,
  decodePaymentSubmission,
  forFacilitator,
  isExactEvmPayload,
  isExactPermit2Payload,
} from './payload';
import { X402_DEFAULT_PAYMENT_FLOW, type X402PaymentFlow } from './payment-flow';
import { computePermit2ReplayKey, computeReplayKey } from './replay-key';

const X402_VERSION = 2;
const X402_PROTOCOL_VERSION = String(X402_VERSION);
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MIME_TYPE = 'application/json';
const HEALTH_TIMEOUT_MS = 4_000;
// `SettleResponse.errorReason` the SDK uses for "broadcast, not confirmed"
const SETTLEMENT_PENDING_REASON = 'settlement_pending';
/**
 * Each family's catch-all for a throw from the broadcast call, and its reason
 * for a transaction that failed on chain. Only the second carries a
 * transaction reference. A failure the SDK recognizes before the broadcast gets
 * its own reason instead. The EVM Permit2 path appends the thrown message as
 * `: <message>`. On NEAR the second is a failed inner `ft_transfer` receipt.
 */
const TRANSACTION_FAILED_REASONS = [
  'invalid_exact_evm_transaction_failed',
  'invalid_exact_svm_transaction_failed',
  'settlement_failed',
];
const isTransactionFailedReason = (reason: string | undefined): boolean =>
  reason !== undefined &&
  TRANSACTION_FAILED_REASONS.some((known) => reason === known || reason.startsWith(`${known}:`));
/**
 * Solana outcomes that leave the payment unknown: the facilitator is already
 * settling the same transaction for another request, or it confirmed the
 * transaction but could not yet see the transfer
 */
const UNKNOWN_OUTCOME_REASONS: ReadonlySet<string> = new Set([
  'duplicate_settlement',
  'post_settlement_transfer_not_confirmed',
]);
/**
 * Facilitator configuration and chain-read failures yield no payment verdict.
 * The NEAR SDK returns these reasons before submission; classify them as
 * provider failures rather than buyer refusals.
 */
const NO_VERDICT_REASONS: ReadonlySet<string> = new Set([
  'unexpected_verify_error',
  'invalid_exact_near_no_relayer_configured',
  'invalid_exact_near_current_block_height_unavailable',
  'invalid_exact_near_access_key_lookup_failed',
  'invalid_exact_near_account_lookup_failed',
  'invalid_exact_near_token_account_lookup_failed',
  'invalid_exact_near_balance_check_failed',
  'invalid_exact_near_storage_check_failed',
]);
/**
 * NEAR settle failures that are verdicts. The NEAR specification leaves the
 * reason implementation-specific and the transaction empty, even after a
 * submission, so only the SDK's verification reasons, returned before it
 * submits, and a failed inner `ft_transfer` with its hash prove nothing moved.
 */
const NEAR_PRE_SUBMISSION_REASONS: ReadonlySet<string> = new Set([
  'invalid_x402_version',
  'unsupported_scheme',
  'invalid_network',
  'insufficient_funds',
  'verification_failed',
]);
const isNearVerdict = (reason: string | undefined): boolean =>
  reason !== undefined &&
  (reason === 'settlement_failed' ||
    reason.startsWith('invalid_exact_near_') ||
    NEAR_PRE_SUBMISSION_REASONS.has(reason));
// How long a `/supported` snapshot names the Solana fee payer of new offers
const SUPPORTED_TTL_MS = 60_000;
/**
 * `invalidReason`/`errorReason` are `z.string()` in the SDK schema, with no
 * length or charset bound. They reach the buyer's error, the persisted events
 * and the merchant's ledger. A remote facilitator controls these values, so
 * they are treated as untrusted input rather than diagnostic text.
 */
const MAX_REASON_LENGTH = 64;
const REASON_SHAPE = /^[a-z0-9_.-]+$/i;

function sanitizeReason(reason: string | undefined, fallback: string): string {
  if (reason === undefined) return fallback;
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) return fallback;
  return REASON_SHAPE.test(trimmed) ? trimmed : fallback;
}

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
   * Custom EVM networks keyed by CAIP-2 ID; `network` may select one, and
   * its `kind` determines mainnet guardrails
   */
  readonly customNetworks?: CustomNetworks;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
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

/** Prefixed random UUIDs, shared with the MPP rail */
export const DEFAULT_IDS: IdGenerator = {
  next: (prefix?: string) => `${prefix ? `${prefix}_` : ''}${crypto.randomUUID()}`,
};

// Requirement metadata naming the offer `selectRequirement` chose, by index
const SELECTED_OFFER_KEY = 'x402.offer';

// Everything one offer needs at request time, resolved and checked at startup
interface OfferBase {
  readonly network: Network;
  readonly assetDecimals: number;
  readonly rpcUrl: string;
  readonly rpcOrigin: string;
  readonly binding: FacilitatorBinding;
}

interface EvmOffer extends OfferBase {
  readonly family: 'evm';
  readonly profile: Extract<X402Network, { family: 'evm' }>;
  readonly method: X402AssetTransferMethod;
  readonly asset: `0x${string}`;
  readonly assetName: string | undefined;
  readonly assetVersion: string | undefined;
  readonly payTo: `0x${string}`;
  readonly healthClient: ReturnType<typeof createLocalPublicClient>;
}

// Always a remote facilitator: the in-process one serves only the Anvil chain
interface SvmOffer extends OfferBase {
  readonly family: 'svm';
  readonly profile: Extract<X402Network, { family: 'svm' }>;
  readonly asset: string;
  readonly payTo: string;
}

// Always a remote facilitator, like Solana
interface NearOffer extends OfferBase {
  readonly family: 'near';
  readonly profile: Extract<X402Network, { family: 'near' }>;
  readonly asset: string;
  readonly payTo: string;
}

type Offer = EvmOffer | SvmOffer | NearOffer;

export function createX402PaymentProvider(
  options: X402ProviderOptions | X402MultiOfferProviderOptions,
): PaymentProvider {
  const inputs: readonly X402OfferOptions[] = 'offers' in options ? options.offers : [options];
  if (inputs.length === 0) {
    throw new CommerceError('CONFIG_INVALID', 'x402 provider: "offers" is empty');
  }
  // The NEAR facilitator refuses every payment under any other value
  if (
    options.maxTimeoutSeconds !== undefined &&
    (!Number.isInteger(options.maxTimeoutSeconds) || options.maxTimeoutSeconds <= 0)
  ) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: maxTimeoutSeconds must be a positive integer (got ${options.maxTimeoutSeconds})`,
    );
  }
  // Share one remote binding, created after the first offer passes validation
  let remoteBinding: FacilitatorBinding | undefined;

  let mode: DeploymentMode | undefined;
  const seen = new Set<string>();
  const offers = inputs.map((input, index): Offer => {
    const field = (name: string) =>
      inputs.length === 1 ? `"${name}"` : `"offers[${index}].${name}"`;
    // The network decides how the other fields are read. An unknown one
    // fails in `resolveX402Deployment` below.
    const known = findX402Network(input.network, options.customNetworks);
    if (known !== undefined && known.family !== 'evm') {
      const shape =
        known.family === 'svm' ? 'a Solana address (base58, 32 bytes)' : 'a NEAR account ID';
      for (const name of ['asset', 'payTo'] as const) {
        if (normalizeAddress(known, input[name]) === undefined) {
          throw new CommerceError(
            'CONFIG_INVALID',
            `x402 provider: ${field(name)} is not ${shape}`,
          );
        }
      }
      if (input.assetTransferMethod !== undefined) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: ${field('assetTransferMethod')} applies to EVM networks only`,
        );
      }
    } else {
      if (!isAddress(input.asset)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: ${field('asset')} is not a valid EVM address: ${input.asset}`,
        );
      }
      if (!isAddress(input.payTo)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: ${field('payTo')} is not a valid EVM address: ${input.payTo}`,
        );
      }
      // In every facilitator mode. `resolveX402Deployment` below also refuses
      // a dev payTo on any non-local deployment, whatever the RPC host.
      assertPayToIsNotDevAddress(input.rpcUrl, input.payTo);
      // The buyer signs the token's EIP-712 domain under EIP-3009, so the
      // requirement must name it. Permit2 has a domain of its own.
      if (
        (input.assetTransferMethod ?? 'eip3009') === 'eip3009' &&
        (!input.assetName || !input.assetVersion)
      ) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: an EIP-3009 offer needs ${field('assetName')} and ${field('assetVersion')}, the token's EIP-712 domain`,
        );
      }
    }
    if (!Number.isInteger(input.assetDecimals) || input.assetDecimals < 0) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: ${field('assetDecimals')} must be a non-negative integer`,
      );
    }
    // The chain id is signed into the buyer's EIP-712 domain, so a network it
    // cannot be resolved from fails here, never at request time
    const deployment = resolveX402Deployment({
      network: input.network,
      ...(options.customNetworks !== undefined ? { customNetworks: options.customNetworks } : {}),
      payTo: input.payTo,
      asset: input.asset,
      ...(input.assetName !== undefined ? { assetName: input.assetName } : {}),
      ...(input.assetVersion !== undefined ? { assetVersion: input.assetVersion } : {}),
      facilitator: options.facilitator,
      ...(options.allowMainnet !== undefined ? { allowMainnet: options.allowMainnet } : {}),
      ...(options.allowUnauthenticatedFacilitator !== undefined
        ? { allowUnauthenticatedFacilitator: options.allowUnauthenticatedFacilitator }
        : {}),
    });
    const profile = deployment.profile;
    // Refuse offers mixing local, testnet and mainnet deployment modes
    if (mode !== undefined && deployment.mode !== mode) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: offers mix ${mode} and ${deployment.mode} networks; every offer must be on a ${mode} network`,
      );
    }
    mode = deployment.mode;
    // EVM addresses compare without case; Solana's base58 is case-sensitive
    const comparable = (value: string) => (profile.family === 'evm' ? value.toLowerCase() : value);
    const key = `${input.network}|${comparable(input.asset)}|${comparable(input.payTo)}`;
    if (seen.has(key)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: ${field('network')} repeats an earlier offer of the same asset to the same payTo on ${input.network}`,
      );
    }
    seen.add(key);

    // Built once, here, rather than in settle(): an unusable key fails the
    // provider at startup, not on the first paid request after that buyer's
    // replay key is already reserved
    let binding: FacilitatorBinding;
    if (options.facilitator.mode === 'local') {
      assertDevKeyIsLocalOnly(input.rpcUrl, options.facilitator.signerPrivateKey);
      let client: LocalFacilitatorClient;
      try {
        client = createLocalFacilitatorClient(
          input.rpcUrl,
          options.facilitator.signerPrivateKey as `0x${string}`,
        );
      } catch (cause) {
        throw new CommerceError(
          'CONFIG_INVALID',
          'x402 provider: could not construct a local facilitator signer from ' +
            'facilitator.signerPrivateKey. It must be a valid 32-byte hex private key.',
          { cause },
        );
      }
      binding = createLocalFacilitatorBinding(client, input.network, isProviderUnavailableError);
    } else {
      remoteBinding ??= createRemoteFacilitatorBinding({
        url: options.facilitator.url,
        auth: options.facilitator.auth,
      });
      binding = remoteBinding;
    }

    // health() reads the chain itself, with a timeout. Verification and
    // settlement go through the facilitator instead. Health details can reach
    // logs, so they name the RPC by origin.
    const base = {
      network: input.network as Network,
      assetDecimals: input.assetDecimals,
      rpcUrl: input.rpcUrl,
      rpcOrigin: describeRpc(input.rpcUrl),
      binding,
    };
    if (profile.family === 'svm') {
      return { ...base, family: 'svm', profile, asset: input.asset, payTo: input.payTo };
    }
    if (profile.family === 'near') {
      return { ...base, family: 'near', profile, asset: input.asset, payTo: input.payTo };
    }
    return {
      ...base,
      family: 'evm',
      profile,
      method: input.assetTransferMethod ?? 'eip3009',
      asset: input.asset as `0x${string}`,
      assetName: input.assetName,
      assetVersion: input.assetVersion,
      payTo: input.payTo as `0x${string}`,
      healthClient: createLocalPublicClient(input.rpcUrl, HEALTH_TIMEOUT_MS, profile.chainId),
    };
  });
  const deploymentMode = mode as DeploymentMode;

  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? DEFAULT_IDS;
  const logger = options.logger ?? NOOP_LOGGER;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;

  const evmOffers = offers.filter((offer): offer is EvmOffer => offer.family === 'evm');
  const hasSvm = offers.some((offer) => offer.family === 'svm');
  const hasNear = offers.some((offer) => offer.family === 'near');
  const descriptor: AdapterDescriptor = {
    name: 'x402',
    kind: 'payment',
    implementationVersion: PACKAGE_VERSION,
    supportedSpec: `x402/v${X402_VERSION} scheme=exact family=${[
      ...(evmOffers.length > 0 ? ['eip155'] : []),
      ...(hasSvm ? ['solana'] : []),
      ...(hasNear ? ['near'] : []),
    ].join(',')}`,
    capabilities: [
      ...(evmOffers.length > 0 ? ['exact-evm'] : []),
      ...(hasSvm ? ['exact-svm'] : []),
      ...(hasNear ? ['exact-near'] : []),
      `${options.facilitator.mode}-facilitator`,
      ...(evmOffers.some((offer) => offer.method === 'eip3009') ? ['eip-3009'] : []),
      ...(evmOffers.some((offer) => offer.method === 'permit2') ? ['permit2'] : []),
      'caip-2',
      `mode=${deploymentMode}`,
      'authorization-flow',
      'upfront-flow',
      ...(offers.length > 1 ? ['multiple-offers'] : []),
    ],
    status: 'stable',
    unsupported: [
      'permit2 gas sponsoring extensions',
      'upto scheme',
      'batch-settlement scheme',
      'auth-capture scheme',
    ],
  };

  // Loaded only with an offer of their family, so no deployment needs the
  // peers of a family it does not offer
  const svmModule = hasSvm
    ? loadOptionalModule(() => import('./svm'), 'Solana offers need @x402/svm and @solana/kit')
    : undefined;
  const nearModule = hasNear
    ? loadOptionalModule(() => import('./near'), 'NEAR offers need @x402/near')
    : undefined;
  const svm = async () => {
    if (!svmModule) throw new Error('x402 provider: no Solana offer is configured');
    return svmModule;
  };
  const near = async () => {
    if (!nearModule) throw new Error('x402 provider: no NEAR offer is configured');
    return nearModule;
  };

  // A Solana offer carries the fee payer the facilitator names in `/supported`.
  // A snapshot lasts SUPPORTED_TTL_MS, and a refresh keeps the previous fee
  // payer while the facilitator still lists it, so a challenge and the retry
  // that pays it agree.
  let supportedSnapshot:
    | { readonly at: number; readonly response: Promise<SupportedResponse> }
    | undefined;
  const feePayers = new Map<string, string>();

  function currentSupported(): Promise<SupportedResponse> {
    const now = clock.monotonicMs();
    if (supportedSnapshot && now - supportedSnapshot.at < SUPPORTED_TTL_MS) {
      return supportedSnapshot.response;
    }
    const remote = remoteBinding as Extract<FacilitatorBinding, { kind: 'remote' }>;
    const response = remote.supported();
    const snapshot = { at: now, response };
    supportedSnapshot = snapshot;
    // A failed fetch is not kept; the next challenge asks again
    response.catch(() => {
      if (supportedSnapshot === snapshot) supportedSnapshot = undefined;
    });
    return response;
  }

  async function svmFeePayer(offer: SvmOffer): Promise<string> {
    let supported: SupportedResponse;
    try {
      supported = await currentSupported();
    } catch (cause) {
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `x402 provider: facilitator ${offer.binding.describe} did not answer /supported, which names the Solana fee payer`,
        { cause },
      );
    }
    const listed = supported.kinds.find(
      (kind) =>
        kind.x402Version === X402_VERSION &&
        kind.scheme === 'exact' &&
        kind.network === offer.network,
    )?.extra?.['feePayer'];
    const previous = feePayers.get(offer.network);
    const stillSigns =
      previous !== undefined &&
      (previous === listed || Object.values(supported.signers).some((s) => s.includes(previous)));
    const feePayer = stillSigns ? previous : listed;
    if (typeof feePayer !== 'string' || normalizeAddress(offer.profile, feePayer) === undefined) {
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `x402 provider: facilitator ${offer.binding.describe} names no Solana fee payer for ${offer.network}`,
      );
    }
    feePayers.set(offer.network, feePayer);
    return feePayer;
  }

  // Use the selected or sole offer; multi-offer challenges require selection
  function offerIndexOf(requirement: PaymentRequirement): number | undefined {
    const selected = requirement.metadata?.[SELECTED_OFFER_KEY];
    if (typeof selected === 'number') return selected;
    // An empty list falls through to 'missing_payment_requirements'
    return requirement.challenge.accepts.length <= 1 ? 0 : undefined;
  }

  async function createRequirement(context: PaymentContext): Promise<PaymentRequirement> {
    const paymentFlow =
      options.resourcePaymentFlows?.[context.resource.id] ??
      options.paymentFlow ??
      X402_DEFAULT_PAYMENT_FLOW;

    // x402 requires an explicit non-default flow. Omit the default
    // `authorization` flow here.
    const flow = paymentFlow === 'upfront' ? { paymentFlow } : {};
    const accepts: PaymentRequirements[] = await Promise.all(
      offers.map(async (offer) => ({
        scheme: 'exact',
        network: offer.network,
        asset: offer.asset,
        amount: parseCanonicalAmount(context.amount, offer.assetDecimals).toString(),
        payTo: offer.payTo,
        maxTimeoutSeconds,
        // EIP-3009 needs `name`/`version` for a shared EIP-712 domain without
        // a token `version()` call; Permit2 uses its own domain. EVM clients
        // sign the named `assetTransferMethod`. Solana needs the facilitator's
        // fee payer; NEAR needs no scheme-specific extra because the
        // facilitator chooses its relayer.
        extra:
          offer.family === 'svm'
            ? { feePayer: await svmFeePayer(offer), ...flow }
            : offer.family === 'near'
              ? { ...flow }
              : {
                  ...(offer.assetName !== undefined ? { name: offer.assetName } : {}),
                  ...(offer.assetVersion !== undefined ? { version: offer.assetVersion } : {}),
                  assetTransferMethod: offer.method,
                  ...flow,
                },
      })),
    );
    const single = offers.length === 1 ? offers[0] : undefined;

    // The v2 challenge document as sent on the wire. The HTTP adapter
    // base64-encodes it into `PAYMENT-REQUIRED` and MCP passes it through, so
    // both surfaces offer the same challenge.
    //
    // `resource.url` is outside the EIP-3009 signature. A single offer puts its
    // network and payee in it, so the buyer's echo identifies the offer. With
    // several, the URL stays the same whichever one the buyer pays.
    const resourceId = encodeURIComponent(context.resource.id);
    const envelope: PaymentRequired = {
      x402Version: X402_VERSION,
      resource: {
        url: single
          ? `resource://agent-commerce/${encodeURIComponent(single.network)}/${single.payTo}/resources/${resourceId}`
          : `resource://agent-commerce/resources/${resourceId}`,
        description: context.resource.description ?? context.resource.name,
        mimeType: DEFAULT_MIME_TYPE,
      },
      accepts,
    };

    const expiresAt = new Date(clock.now().getTime() + maxTimeoutSeconds * 1000).toISOString();

    return {
      id: ids.next('payreq'),
      requestId: context.requestId,
      resourceId: context.resource.id,
      provider: 'x402',
      amount: context.amount,
      currency: context.currency,
      // Several offers name several destinations; selection fills these in
      ...(single
        ? { destination: single.payTo, network: single.network, asset: single.asset }
        : {}),
      expiresAt,
      challenge: {
        provider: 'x402',
        version: X402_PROTOCOL_VERSION,
        accepts: accepts as unknown as Record<string, unknown>[],
        envelope: envelope as unknown as Record<string, unknown>,
      },
      metadata: {
        [SETTLE_AFTER_BACKEND_METADATA_KEY]: paymentFlow === 'authorization',
        // The SDK server keeps no record of a payload whose handler or
        // settlement failed and verifies it again; the chain spends it once
        [REUSE_REJECTED_AUTHORIZATION_METADATA_KEY]: true,
      },
    };
  }

  /**
   * Selects the unique offer matching `accepted`, leaving zero or multiple
   * matches unchanged for `verify()` to reject. Selection identifies the
   * claimed offer; verification still validates the proof.
   */
  async function selectRequirement(
    context: PaymentVerificationContext,
  ): Promise<PaymentRequirement> {
    const { requirement, submission } = context;
    const offered = requirement.challenge.accepts as unknown as PaymentRequirements[];
    if (offered.length < 2) return requirement;
    const payload = decodePaymentSubmission(submission.payload);
    if (!payload) return requirement;
    const matches = offered.flatMap((offer, index) =>
      acceptedMatchesOffer(offer, payload.accepted, offers[index]?.profile) ? [index] : [],
    );
    const index = matches.length === 1 ? matches[0] : undefined;
    const offer = index === undefined ? undefined : offers[index];
    if (index === undefined || !offer) return requirement;
    return {
      ...requirement,
      destination: offer.payTo,
      network: offer.network,
      asset: offer.asset,
      metadata: { ...requirement.metadata, [SELECTED_OFFER_KEY]: index },
    };
  }

  /**
   * Checks a submission against the requirement this provider built, never
   * against `payload.accepted`, the copy the client echoes back. That copy
   * must itself match the offer, or the proof is refused.
   *
   * The `exact` scheme requires the authorized amount to match exactly,
   * including when the buyer offers more. Local refusals use x402 error codes
   * where available.
   */
  async function verify(context: PaymentVerificationContext): Promise<PaymentResult> {
    const { requirement, submission } = context;

    const rejected = (reason: string): PaymentResult => ({
      status: 'rejected',
      provider: 'x402',
      amount: requirement.amount,
      currency: requirement.currency,
      ...(requirement.network !== undefined ? { network: requirement.network } : {}),
      ...(requirement.asset !== undefined ? { asset: requirement.asset } : {}),
      rejectionReason: reason,
    });

    if (requirement.provider !== 'x402' || requirement.challenge.provider !== 'x402') {
      return rejected('wrong_provider');
    }

    // With several offers and none selected, the proof matched no single offer
    const index = offerIndexOf(requirement);
    if (index === undefined) {
      return rejected('invalid_payment_requirements');
    }
    const offer = offers[index];
    const requirements = requirement.challenge.accepts[index] as PaymentRequirements | undefined;
    if (!offer || !requirements) {
      return rejected('missing_payment_requirements');
    }

    // Defense in depth only: the pipeline builds a fresh requirement for every
    // request, so this rarely fires. The real expiry is the authorization's
    // own, which the facilitator checks.
    if (
      requirement.expiresAt !== undefined &&
      Date.parse(requirement.expiresAt) < clock.now().getTime()
    ) {
      return rejected('requirement_expired');
    }

    // This provider built the requirement, so the asset always matches in
    // normal operation. A corrupted one must still never authorize a transfer
    // of a different asset.
    if (!sameAddress(offer.profile, requirements.asset, offer.asset)) {
      return rejected('wrong_asset');
    }

    const payload = decodePaymentSubmission(submission.payload);
    if (!payload) {
      const version = declaredX402Version(submission.payload);
      return rejected(
        typeof version === 'number' && version !== X402_VERSION
          ? 'invalid_x402_version'
          : 'invalid_payload',
      );
    }
    if (payload.x402Version !== X402_VERSION) {
      return rejected('invalid_x402_version');
    }
    // EVM: the authorization names payer, payee and amount. Solana: the
    // facilitator reads the transaction, and the gateway takes its identity.
    // NEAR: the delegate names the transfer, checked here against the offer.
    let transfer: Transfer | undefined;
    let replayKey: string;
    let derivedPayer: string | undefined;
    if (offer.family === 'svm') {
      const identity = (await svm()).svmReplayKey(payload.payload, offer.network);
      if (typeof identity === 'string') return rejected(identity);
      replayKey = identity.replayKey;
    } else if (offer.family === 'near') {
      const inspected = (await near()).inspectNearPayload(payload.payload, {
        network: offer.network,
        asset: offer.asset,
        payTo: offer.payTo,
        amount: requirements.amount,
      });
      if (typeof inspected === 'string') return rejected(inspected);
      replayKey = inspected.replayKey;
      derivedPayer = inspected.payer;
    } else {
      const read = readTransfer(payload, offer);
      if (typeof read === 'string') return rejected(read);
      transfer = read;
      replayKey = read.replayKey;
      derivedPayer = read.from;
    }
    // Reject a different network before calling the facilitator. NEAR's
    // delegate signature itself does not bind the chain.
    if (payload.accepted.network !== offer.network) {
      return rejected('invalid_network');
    }
    // The signature omits flow and resource. Check the echoed offer;
    // `resource` is optional, but must match when present.
    const offeredUrl = (requirement.challenge.envelope as PaymentRequired | undefined)?.resource
      ?.url;
    if (
      !acceptedMatchesOffer(requirements, payload.accepted, offer.profile) ||
      (payload.resource !== undefined && payload.resource.url !== offeredUrl)
    ) {
      return rejected('invalid_payment_requirements');
    }
    let required: bigint;
    try {
      required = BigInt(requirements.amount);
    } catch {
      return rejected('invalid_payload');
    }
    if (transfer) {
      if (transfer.to !== getAddress(offer.payTo)) {
        return rejected(transfer.recipientMismatch);
      }
      let authorizedValue: bigint;
      try {
        authorizedValue = BigInt(transfer.value);
      } catch {
        return rejected('invalid_payload');
      }
      if (authorizedValue !== required) {
        return rejected(transfer.amountMismatch);
      }
    }

    const scope = offer.binding.open();
    let sdkResult: VerifyResponse;
    try {
      sdkResult = await scope.verify(forFacilitator(payload), requirements);
    } catch (err) {
      // A throw means no verdict was obtained, so it is never held against the
      // buyer. Only an unclassified one is logged, as it may be an SDK fault.
      if (!isProviderUnavailableError(err) && !scope.transportFailed()) {
        logger.warn({ err: redactedErrorText(err) }, 'x402 verify(): unexpected SDK error');
      }
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `x402 provider: ${offer.binding.kind} facilitator returned no verdict during verify()`,
        { cause: err },
      );
    }

    if (!sdkResult.isValid) {
      // An RPC that never answered is not a payment that failed a check
      if (scope.transportFailed() || NO_VERDICT_REASONS.has(sdkResult.invalidReason ?? '')) {
        if (sdkResult.invalidReason !== undefined) {
          logger.debug(
            { reportedReason: redactedErrorText(sdkResult.invalidReason) },
            'x402 verify(): local facilitator transport failure reason',
          );
        }
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          `x402 provider: ${offer.binding.kind} facilitator unreachable during verify()`,
        );
      }
      // The raw reason is logged at debug level. Only what the buyer sees and
      // the ledger records is constrained.
      if (sdkResult.invalidReason !== undefined) {
        logger.debug(
          { reportedReason: redactedErrorText(sdkResult.invalidReason) },
          'x402 verify(): facilitator rejection reason',
        );
      }
      return rejected(sanitizeReason(sdkResult.invalidReason, 'invalid_payment'));
    }

    // The Solana payer is the facilitator's reading of the transaction
    const payer =
      derivedPayer ??
      (sdkResult.payer !== undefined && normalizeAddress(offer.profile, sdkResult.payer)
        ? sdkResult.payer
        : undefined);
    return {
      status: 'verified',
      provider: 'x402',
      ...(payer !== undefined ? { payer } : {}),
      payee: transfer?.to ?? offer.payTo,
      amount: formatUnits(required, offer.assetDecimals),
      currency: requirement.currency,
      network: payload.accepted.network,
      asset: offer.family === 'evm' ? getAddress(requirements.asset) : offer.asset,
      replayKey,
    };
  }

  async function settle(context: PaymentSettlementContext): Promise<PaymentResult> {
    const { requirement, submission, verification } = context;

    if (verification.status !== 'verified') {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'x402 provider: settle() called without a successful verify()',
      );
    }

    const index = offerIndexOf(requirement);
    const offer = index === undefined ? undefined : offers[index];
    const requirements =
      index === undefined
        ? undefined
        : (requirement.challenge.accepts[index] as PaymentRequirements | undefined);
    if (!offer || !requirements) {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'x402 provider: settle() found no payment requirements to settle against',
      );
    }

    const payload = decodePaymentSubmission(submission.payload);
    const transfer = payload && offer.family === 'evm' ? readTransfer(payload, offer) : undefined;
    if (!payload || typeof transfer === 'string') {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'x402 provider: settle() received an undecodable payment payload',
      );
    }
    const reference = (value: string) => isTransactionReference(offer.profile, value);

    const rejectedSettlement = (rejectionReason: string): PaymentResult => ({
      status: 'rejected',
      provider: 'x402',
      amount: verification.amount,
      currency: requirement.currency,
      ...(verification.network !== undefined ? { network: verification.network } : {}),
      ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
      ...(verification.replayKey !== undefined ? { replayKey: verification.replayKey } : {}),
      rejectionReason,
    });

    const scope = offer.binding.open();
    let sdkResult: SettleResponse;
    try {
      sdkResult = await scope.settle(forFacilitator(payload), requirements);
    } catch (err) {
      if (isProviderUnavailableError(err) || scope.transportFailed()) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          `x402 provider: ${offer.binding.kind} facilitator unreachable during settle()`,
          { cause: err },
        );
      }
      // The pinned SDK returns a result for every failure from gas estimation
      // on, so a throw comes from its checks before anything is sent. A revert
      // there is a real rejection, which releases any mandate the pipeline
      // holds for the purchase. Any other throw goes back as an unavailable
      // provider, which the pipeline records as `settlement-uncertain`, never
      // as a rejection blamed on the buyer.
      if (!isOnChainRevertError(err)) {
        logger.warn(
          { err: redactedErrorText(err) },
          'x402 settle(): settlement failed with an unclassified error; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement failed with an unclassified error; outcome unknown',
          { cause: err },
        );
      }
      logger.warn(
        { err: redactedErrorText(err), rejectionReason: 'transaction_reverted' },
        'x402 settle(): settlement transaction reverted on chain',
      );
      return rejectedSettlement('transaction_reverted');
    }

    // verify() established the payer. The Solana scheme's settlement example
    // names the fee payer there, while x402 v2 defines the payer's wallet.
    const payer = verification.payer ?? sdkResult.payer;

    if (!sdkResult.success) {
      // "Broadcast, never confirmed" is not "did not happen": the transfer may
      // be on-chain, so it throws as an unavailable provider carrying the hash,
      // and the pipeline records the attempt `settlement-uncertain`, not
      // `rejected`. The SDK's catch-all without a hash is treated the same way,
      // because its throw may have followed a broadcast and viem reports an
      // RPC error on the send as a revert. Everything else is a real rejection.
      if (isTransactionFailedReason(sdkResult.errorReason) && !reference(sdkResult.transaction)) {
        // The appended message can carry an RPC URL
        logger.warn(
          { reportedReason: redactedErrorText(sdkResult.errorReason) },
          'x402 settle(): the broadcast failed without a transaction hash; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement failed with an unclassified error; outcome unknown',
        );
      }
      // A broadcast the SDK could not confirm nor record for a retry comes
      // back as its catch-all with the transaction, and a message starting
      // `settlement_pending`
      if (
        sdkResult.errorReason === SETTLEMENT_PENDING_REASON ||
        sdkResult.errorMessage?.startsWith(SETTLEMENT_PENDING_REASON) === true ||
        UNKNOWN_OUTCOME_REASONS.has(sdkResult.errorReason ?? '') ||
        NO_VERDICT_REASONS.has(sdkResult.errorReason ?? '') ||
        scope.transportFailed()
      ) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement was broadcast but could not be confirmed',
          {
            ...(sdkResult.transaction
              ? { details: { transactionHash: sdkResult.transaction } }
              : {}),
          },
        );
      }
      // A `settlement_failed` that reaches here carries its hash
      if (offer.family === 'near' && !isNearVerdict(sdkResult.errorReason)) {
        logger.warn(
          { reportedReason: redactedErrorText(sdkResult.errorReason ?? '') },
          'x402 settle(): NEAR facilitator failure reason is not a verdict; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement failed with an unclassified error; outcome unknown',
        );
      }
      if (sdkResult.errorReason !== undefined) {
        logger.debug(
          { reportedReason: redactedErrorText(sdkResult.errorReason) },
          'x402 settle(): facilitator failure reason',
        );
      }
      return {
        ...rejectedSettlement(sanitizeReason(sdkResult.errorReason, 'settlement_failed')),
        network: sdkResult.network,
        ...(payer !== undefined ? { payer } : {}),
      };
    }

    // A success names the offer's network and a transaction in its family's
    // form; anything else unlocks nothing, and the outcome stays unknown
    if (!reference(sdkResult.transaction) || sdkResult.network !== offer.network) {
      logger.warn(
        { network: sdkResult.network },
        'x402 settle(): the facilitator reported a success it did not identify; outcome unknown',
      );
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'x402 provider: the facilitator reported a settlement without a valid transaction; outcome unknown',
      );
    }

    return {
      status: 'settled',
      provider: 'x402',
      externalReference: sdkResult.transaction,
      ...(payer !== undefined ? { payer } : {}),
      payee: requirements.payTo,
      amount: verification.amount,
      currency: requirement.currency,
      network: sdkResult.network,
      ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
      ...(verification.replayKey !== undefined ? { replayKey: verification.replayKey } : {}),
      settledAt: clock.nowIso(),
      // `amount` is the display value; x402's settlement response reports base
      // units. verify() matched an EVM authorization's value to the offer.
      metadata: { amountBaseUnits: transfer?.value ?? requirements.amount },
    };
  }

  // One offer's chain, asset and facilitator support. `kinds` fetches the
  // remote facilitator's `/supported` once per probe, shared by every offer.
  async function offerHealth(
    offer: Offer,
    kinds: () => Promise<readonly SupportedKind[]>,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
    if (offer.family === 'svm') return svmOfferHealth(offer, kinds);
    if (offer.family === 'near') return nearOfferHealth(offer, kinds);
    const { profile, rpcOrigin, healthClient, binding } = offer;
    const chainId = await healthClient.getChainId();
    if (chainId !== profile.chainId) {
      return {
        status: 'fail',
        detail: `RPC at ${rpcOrigin} reports chain id ${chainId}, expected ${profile.chainId} (${profile.displayName})`,
      };
    }

    const code = await healthClient.getCode({ address: offer.asset });
    if (!code || code === '0x') {
      return {
        status: 'fail',
        detail: `No contract code found at configured asset address ${offer.asset}`,
      };
    }
    // Permit2 offers settle through two contracts the merchant does not deploy
    if (offer.method === 'permit2') {
      for (const [name, address] of PERMIT2_CONTRACTS) {
        const deployed = await healthClient.getCode({ address });
        if (!deployed || deployed === '0x') {
          return {
            status: 'fail',
            detail: `No ${name} contract code found at ${address} on ${profile.displayName}`,
          };
        }
      }
    }
    const contracts = `asset ${offer.asset}${offer.method === 'permit2' ? ', Permit2 and its x402 proxy' : ''}`;

    if (binding.kind === 'remote') {
      // Reachable is not enough: a facilitator that does not carry our
      // scheme on our network fails every payment after the buyer has signed
      const supportsUs = (await kinds()).some(
        (kind) =>
          kind.x402Version === X402_VERSION &&
          kind.scheme === 'exact' &&
          kind.network === offer.network,
      );
      if (!supportsUs) {
        return {
          status: 'fail',
          detail:
            `Facilitator ${binding.describe} does not advertise x402 v${X402_VERSION} scheme=exact ` +
            `on ${offer.network} (${profile.displayName}); no payment on this deployment can settle`,
        };
      }
      return {
        status: 'pass',
        detail:
          `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} reachable, chain id ` +
          `${profile.chainId} (${profile.displayName}), ${contracts} have code, ` +
          `facilitator ${binding.describe} supports exact/${offer.network}`,
      };
    }

    // An RPC reports whatever chain id it was started with, so the id cannot
    // prove this is a dev chain. An Anvil-only RPC method must answer before
    // a local facilitator counts as healthy.
    const isAnvil = await probeIsAnvilNode(healthClient);
    if (!isAnvil) {
      return {
        status: 'fail',
        detail:
          `RPC at ${rpcOrigin} reports chain id ${profile.chainId} but does not answer ` +
          '"anvil_nodeInfo", so it does not look like a local Anvil dev node. Refusing to treat it ' +
          'as safe for a local-facilitator dev key.',
      };
    }

    return {
      status: 'pass',
      detail:
        `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} reachable, chain id ` +
        `${profile.chainId}, ${contracts} have code, confirmed Anvil dev node`,
    };
  }

  // A Solana offer's cluster, mint and fee payer. The CAIP-2 reference is the
  // start of the genesis hash, so the RPC proves which cluster it serves.
  async function svmOfferHealth(
    offer: SvmOffer,
    kinds: () => Promise<readonly SupportedKind[]>,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
    const { profile, rpcOrigin, binding } = offer;
    // A missing Solana peer fails readiness, not the first paid request
    await svm();
    const genesis = await jsonRpc(offer.rpcUrl, 'getGenesisHash', []);
    const cluster = typeof genesis === 'string' ? `solana:${genesis.slice(0, 32)}` : undefined;
    if (cluster !== offer.network) {
      return {
        status: 'fail',
        detail: `RPC at ${rpcOrigin} serves ${cluster ?? 'an unknown cluster'}, expected ${offer.network} (${profile.displayName})`,
      };
    }
    const mint = await jsonRpc(offer.rpcUrl, 'getAccountInfo', [
      offer.asset,
      { encoding: 'base64' },
    ]);
    const decimals = mintDecimals(mint);
    if (decimals === undefined) {
      return {
        status: 'fail',
        detail: `No initialized token mint found at configured asset address ${offer.asset}`,
      };
    }
    if (decimals !== offer.assetDecimals) {
      return {
        status: 'fail',
        detail: `Mint ${offer.asset} has ${decimals} decimals, configured ${offer.assetDecimals}`,
      };
    }
    const feePayer = (await kinds()).find(
      (kind) =>
        kind.x402Version === X402_VERSION &&
        kind.scheme === 'exact' &&
        kind.network === offer.network,
    )?.extra?.['feePayer'];
    if (typeof feePayer !== 'string' || normalizeAddress(profile, feePayer) === undefined) {
      return {
        status: 'fail',
        detail:
          `Facilitator ${binding.describe} does not advertise x402 v${X402_VERSION} scheme=exact ` +
          `on ${offer.network} (${profile.displayName}) with a fee payer; no payment on this deployment can settle`,
      };
    }
    return {
      status: 'pass',
      detail:
        `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} serves ${profile.displayName}, ` +
        `mint ${offer.asset} has ${decimals} decimals, facilitator ${binding.describe} supports ` +
        `exact/${offer.network} with fee payer ${feePayer}`,
    };
  }

  // A NEAR offer's chain, token and merchant registration. The RPC's `status`
  // names the chain it serves; an account suffix such as `.testnet` proves nothing.
  async function nearOfferHealth(
    offer: NearOffer,
    kinds: () => Promise<readonly SupportedKind[]>,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
    const { profile, rpcOrigin, binding, rpcUrl } = offer;
    // A missing NEAR peer fails readiness, not the first paid request
    await near();
    const status = await jsonRpc(rpcUrl, 'status', []);
    const chainId = isRecord(status) ? status['chain_id'] : undefined;
    const expected = offer.network.slice('near:'.length);
    if (chainId !== expected) {
      return {
        status: 'fail',
        detail: `RPC at ${rpcOrigin} serves chain ${String(chainId ?? 'unknown')}, expected ${expected} (${profile.displayName})`,
      };
    }
    const token = await jsonRpc(rpcUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: offer.asset,
    });
    if (!isRecord(token) || token['code_hash'] === NEAR_EMPTY_CODE_HASH) {
      return {
        status: 'fail',
        detail: `No contract code found at configured asset account ${offer.asset}`,
      };
    }
    const metadata = await nearView(rpcUrl, offer.asset, 'ft_metadata', {});
    const decimals = isRecord(metadata) ? metadata['decimals'] : undefined;
    if (decimals !== offer.assetDecimals) {
      return {
        status: 'fail',
        detail: `Token ${offer.asset} has ${String(decimals)} decimals, configured ${offer.assetDecimals}`,
      };
    }
    // An unregistered recipient makes every transfer fail after the relayer
    // paid for it. A token without NEP-145 storage management needs none.
    let registered = true;
    try {
      registered =
        (await nearView(rpcUrl, offer.asset, 'storage_balance_of', {
          account_id: offer.payTo,
        })) !== null;
    } catch (err) {
      if (!/MethodNotFound|MethodResolveError/i.test(redactedErrorText(err))) throw err;
    }
    if (!registered) {
      return {
        status: 'fail',
        detail: `payTo ${offer.payTo} has no storage registered with token ${offer.asset}; register it (NEP-145 storage_deposit) before taking payments`,
      };
    }
    const listed = (await kinds()).some(
      (kind) =>
        kind.x402Version === X402_VERSION &&
        kind.scheme === 'exact' &&
        kind.network === offer.network,
    );
    if (!listed) {
      return {
        status: 'fail',
        detail:
          `Facilitator ${binding.describe} does not advertise x402 v${X402_VERSION} scheme=exact ` +
          `on ${offer.network} (${profile.displayName}); no payment on this deployment can settle`,
      };
    }
    return {
      status: 'pass',
      detail:
        `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} serves ${expected}, ` +
        `token ${offer.asset} has ${decimals} decimals and storage for ${offer.payTo}, ` +
        `facilitator ${binding.describe} supports exact/${offer.network}`,
    };
  }

  // Unhealthy offers fail readiness; challenges retain the complete offer list
  async function computeHealth(): Promise<AdapterHealth> {
    const startedAt = clock.monotonicMs();
    const checkedAt = clock.nowIso();
    let supported: Promise<readonly SupportedKind[]> | undefined;
    const kinds = () => {
      supported ??= (remoteBinding as Extract<FacilitatorBinding, { kind: 'remote' }>)
        .supported()
        .then((response) => response.kinds);
      return supported;
    };
    const label = (offer: Offer, index: number, detail: string) =>
      offers.length === 1 ? detail : `offer ${index} (${offer.network}): ${detail}`;

    try {
      const details: string[] = [];
      for (const [index, offer] of offers.entries()) {
        const result = await offerHealth(offer, kinds);
        if (result.status === 'fail') {
          return {
            status: 'fail',
            detail: label(offer, index, result.detail),
            checkedAt,
            durationMs: clock.monotonicMs() - startedAt,
          };
        }
        details.push(label(offer, index, result.detail));
      }
      return {
        status: 'pass',
        detail: details.join('; '),
        checkedAt,
        durationMs: clock.monotonicMs() - startedAt,
      };
    } catch (err) {
      return {
        status: 'fail',
        detail: `x402 health check failed: ${redactedErrorText(err)}`,
        checkedAt,
        durationMs: clock.monotonicMs() - startedAt,
      };
    }
  }

  // A probe makes several upstream calls, and `/ready` is unauthenticated.
  // A short TTL plus one shared in-flight probe keeps upstream volume independent
  // of request volume, for library callers as well as the gateway, whose
  // readiness probe adds its own cache on top. Pass and fail share the TTL: a
  // shorter one for fail would bring the load back during an RPC outage,
  // exactly when each call is slowest.
  const HEALTH_CACHE_MS = 5_000;
  let cachedHealth: { at: number; value: AdapterHealth } | undefined;
  let inFlightHealth: Promise<AdapterHealth> | undefined;

  async function health(): Promise<AdapterHealth> {
    const now = clock.monotonicMs();
    if (cachedHealth && now - cachedHealth.at < HEALTH_CACHE_MS) {
      return cachedHealth.value;
    }
    if (inFlightHealth) return inFlightHealth;

    inFlightHealth = computeHealth()
      .then((value) => {
        cachedHealth = { at: clock.monotonicMs(), value };
        return value;
      })
      .finally(() => {
        inFlightHealth = undefined;
      });
    return inFlightHealth;
  }

  return {
    name: 'x402',
    descriptor,
    createRequirement,
    // A single offer needs no selection, so its path stays exactly as it was
    ...(offers.length > 1 ? { selectRequirement } : {}),
    verify,
    settle,
    health,
  };
}

const PERMIT2_CONTRACTS = [
  ['Permit2', PERMIT2_ADDRESS],
  ['x402 exact Permit2 proxy', x402ExactPermit2ProxyAddress],
] as const;

/**
 * Loads a family's inspection module, refusing with a clear error when its
 * optional peers are missing
 */
function loadOptionalModule<T>(load: () => Promise<T>, missing: string): Promise<T> {
  const loading = load().catch((cause: unknown) => {
    throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', `x402 provider: ${missing}`, {
      cause,
    });
  });
  // verify() and health() report the failure; nothing else awaits it
  loading.catch(() => {});
  return loading;
}

const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

// The decimals of an initialized SPL Token or Token-2022 mint, from a base64
// `getAccountInfo` result: byte 44 holds them, byte 45 the initialized flag
function mintDecimals(result: unknown): number | undefined {
  const value = isRecord(result) ? result['value'] : undefined;
  if (!isRecord(value) || !TOKEN_PROGRAMS.has(String(value['owner']))) return undefined;
  const data = value['data'];
  if (!Array.isArray(data) || typeof data[0] !== 'string') return undefined;
  const bytes = Buffer.from(data[0], 'base64');
  return bytes.length >= 82 && bytes[45] === 1 ? bytes[44] : undefined;
}

// One JSON-RPC call for health(), bounded like the EVM client's
async function jsonRpc(rpcUrl: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) {
    throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

// A NEAR contract view call at final finality, its result parsed as JSON
async function nearView(
  rpcUrl: string,
  accountId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await jsonRpc(rpcUrl, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  const bytes = isRecord(result) ? result['result'] : undefined;
  if (!Array.isArray(bytes)) throw new Error(`NEAR view ${method} returned no result`);
  return JSON.parse(Buffer.from(bytes as number[]).toString('utf8'));
}

// The code hash of an account without a contract
const NEAR_EMPTY_CODE_HASH = '11111111111111111111111111111111';

// What a payload authorizes, read the way the offer's method settles it
interface Transfer {
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly value: string;
  readonly replayKey: string;
  readonly recipientMismatch: string;
  readonly amountMismatch: string;
}

/**
 * Reads the payer, payee, amount and replay key, or returns a refusal reason.
 * Enforces the offer's method because the SDK facilitator chooses the method
 * from the payload.
 */
function readTransfer(payload: PaymentPayload, offer: EvmOffer): Transfer | string {
  // verify() refuses an `accepted.network` other than the offer's, so this
  // chain id is the one the authorization is bound to
  const { chainId } = offer.profile;
  if (offer.method === 'eip3009') {
    if (!isExactEvmPayload(payload)) return 'unsupported_scheme';
    const { from, to, value, nonce } = payload.payload.authorization;
    if (!isAddress(from) || !isAddress(to)) return 'invalid_payload';
    return {
      from: getAddress(from),
      to: getAddress(to),
      value,
      replayKey: computeReplayKey({
        chainId,
        asset: getAddress(offer.asset),
        from: getAddress(from),
        nonce,
      }),
      recipientMismatch: 'invalid_exact_evm_payload_recipient_mismatch',
      amountMismatch: 'invalid_exact_evm_payload_authorization_value_mismatch',
    };
  }
  if (!isExactPermit2Payload(payload)) return 'unsupported_scheme';
  const { from, spender, permitted, witness, nonce } = payload.payload.permit2Authorization;
  // Permit2 lets the spender move the permitted tokens anywhere; only the x402
  // proxy binds the transfer to the signed witness recipient
  if (getAddress(spender) !== getAddress(x402ExactPermit2ProxyAddress)) {
    return 'invalid_permit2_spender';
  }
  if (getAddress(permitted.token) !== getAddress(offer.asset)) return 'permit2_token_mismatch';
  return {
    from: getAddress(from),
    to: getAddress(witness.to),
    value: permitted.amount,
    replayKey: computePermit2ReplayKey({ chainId, owner: getAddress(from), nonce }),
    recipientMismatch: 'invalid_permit2_recipient_mismatch',
    amountMismatch: 'permit2_amount_mismatch',
  };
}

/**
 * Match echoed terms against the offer. Extra client keys and
 * `maxTimeoutSeconds` do not matter; EVM addresses ignore case, Solana's do
 * not. Compare effective payment flows so an upfront proof cannot pay a default
 * authorization offer.
 */
function acceptedMatchesOffer(
  offered: PaymentRequirements,
  accepted: PaymentRequirements,
  network: X402Network | undefined,
): boolean {
  if (!network) return false;
  const same = (a: string, b: string) => sameAddress(network, a, b);
  const offeredExtra = offered.extra ?? {};
  const acceptedExtra = accepted.extra ?? {};
  const flow = (extra: Record<string, unknown>) =>
    extra['paymentFlow'] ?? X402_DEFAULT_PAYMENT_FLOW;
  return (
    accepted.scheme === offered.scheme &&
    accepted.network === offered.network &&
    accepted.amount === offered.amount &&
    same(accepted.asset, offered.asset) &&
    same(accepted.payTo, offered.payTo) &&
    Object.entries(offeredExtra).every(([key, value]) => acceptedExtra[key] === value) &&
    flow(acceptedExtra) === flow(offeredExtra)
  );
}

// viem wraps every failed contract call in ContractFunctionExecutionError, so
// only the cause chain can show a revert. A revert alone does not prove nothing
// moved, because viem also reports an RPC error on a send as one; settle()
// relies on the SDK throwing only before the broadcast.
function isOnChainRevertError(err: unknown): boolean {
  return (
    err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) !== null
  );
}

/**
 * The `instanceof` checks cover what the pinned viem HTTP transport throws
 * (`HttpRequestError` for every fetch failure, including connection refused,
 * or `TimeoutError`) and what `waitForTransactionReceipt` throws when it stops
 * polling after a broadcast. Message matching is only a fallback for errors
 * outside those classes, such as a raw undici error, because message text can
 * change with any viem or undici upgrade.
 */
function isProviderUnavailableError(err: unknown): boolean {
  if (
    err instanceof HttpRequestError ||
    err instanceof TimeoutError ||
    err instanceof WaitForTransactionReceiptTimeoutError
  ) {
    return true;
  }
  const message = redactedErrorText(err).toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('fetch failed') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('timed out') ||
    message.includes('network error')
  );
}

/**
 * True only when the RPC answers Anvil's own `anvil_nodeInfo` method. A public
 * node, Base Sepolia included, answers "method not found". Never throws.
 */
async function probeIsAnvilNode(
  client: ReturnType<typeof createLocalPublicClient>,
): Promise<boolean> {
  // Anvil-only method, absent from viem's typed PublicRpcSchema, hence the cast
  const request = client.request as unknown as (args: {
    method: string;
    params: unknown[];
  }) => Promise<unknown>;
  try {
    await request({ method: 'anvil_nodeInfo', params: [] });
    return true;
  } catch {
    return false;
  }
}
