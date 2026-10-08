/**
 * x402 payment provider: protocol v2, `exact` scheme, EVM, EIP-3009
 * `transferWithAuthorization`.
 *
 * `verify()` never moves funds. `settle()` does, and throws unless it is handed
 * a successful verification. Both run through a facilitator (see
 * `facilitator.ts`): the SDK's own `x402Facilitator` in this process, or a
 * remote HTTP facilitator.
 */

import type {
  Network,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
} from '@x402/core/types';
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
import { SETTLE_AFTER_BACKEND_METADATA_KEY } from '../../core/execution/settlement-order';
import { PACKAGE_VERSION } from '../../version';
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
  type NetworkProfile,
} from './networks';
import {
  declaredX402Version,
  decodePaymentSubmission,
  isExactEvmPayload,
  withoutResource,
} from './payload';
import { X402_DEFAULT_PAYMENT_FLOW, type X402PaymentFlow } from './payment-flow';
import { computeReplayKey } from './replay-key';

const X402_VERSION = 2;
const X402_PROTOCOL_VERSION = String(X402_VERSION);
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MIME_TYPE = 'application/json';
const HEALTH_TIMEOUT_MS = 4_000;
// `SettleResponse.errorReason` the SDK uses for "broadcast, not confirmed"
const SETTLEMENT_PENDING_REASON = 'settlement_pending';
/**
 * The SDK's catch-all for a throw from the broadcast call, and its reason for
 * a mined transaction that reverted. Only the second carries a hash. A revert
 * the SDK recognizes during gas estimation gets its own reason instead.
 */
const TRANSACTION_FAILED_REASON = 'invalid_exact_evm_transaction_failed';
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

export interface X402ProviderOptions {
  /**
   * CAIP-2 network identifier, e.g. `eip155:84532`. The chain id it carries is
   * part of the EIP-712 domain the buyer signs, so it is read from this value
   * rather than defaulted.
   */
  readonly network: string;
  /** RPC endpoint. Local chain: http://127.0.0.1:8545 */
  readonly rpcUrl: string;
  /** ERC-20 (EIP-3009) asset address used for settlement */
  readonly asset: `0x${string}`;
  /** EIP-712 domain name of the asset, e.g. 'MockUSDC' */
  readonly assetName: string;
  /** EIP-712 domain version of the asset, e.g. '2' */
  readonly assetVersion: string;
  readonly assetDecimals: number;
  /** Merchant-controlled settlement destination. Never a gateway-owned wallet */
  readonly payTo: `0x${string}`;
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
  /** CAIP-2 network identifier, e.g. `eip155:8453` */
  readonly network: string;
  /** RPC endpoint of that network, for health checks and a local facilitator */
  readonly rpcUrl: string;
  /** ERC-20 (EIP-3009) asset address used for settlement */
  readonly asset: `0x${string}`;
  /** EIP-712 domain name of the asset */
  readonly assetName: string;
  /** EIP-712 domain version of the asset */
  readonly assetVersion: string;
  readonly assetDecimals: number;
  /** Merchant-controlled settlement destination. Never a gateway-owned wallet */
  readonly payTo: `0x${string}`;
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
interface Offer {
  readonly network: Network;
  readonly profile: NetworkProfile;
  readonly asset: `0x${string}`;
  readonly assetName: string;
  readonly assetVersion: string;
  readonly assetDecimals: number;
  readonly payTo: `0x${string}`;
  readonly rpcOrigin: string;
  readonly healthClient: ReturnType<typeof createLocalPublicClient>;
  readonly binding: FacilitatorBinding;
}

export function createX402PaymentProvider(
  options: X402ProviderOptions | X402MultiOfferProviderOptions,
): PaymentProvider {
  const inputs: readonly X402OfferOptions[] = 'offers' in options ? options.offers : [options];
  if (inputs.length === 0) {
    throw new CommerceError('CONFIG_INVALID', 'x402 provider: "offers" is empty');
  }
  // Share one remote binding, created after the first offer passes validation
  let remoteBinding: FacilitatorBinding | undefined;

  let mode: DeploymentMode | undefined;
  const seen = new Set<string>();
  const offers = inputs.map((input, index): Offer => {
    const field = (name: string) =>
      inputs.length === 1 ? `"${name}"` : `"offers[${index}].${name}"`;
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
    // In every facilitator mode. `resolveX402Deployment` below also refuses a
    // dev payTo on any non-local deployment, whatever the RPC host.
    assertPayToIsNotDevAddress(input.rpcUrl, input.payTo);
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
      assetName: input.assetName,
      assetVersion: input.assetVersion,
      facilitator: options.facilitator,
      ...(options.allowMainnet !== undefined ? { allowMainnet: options.allowMainnet } : {}),
      ...(options.allowUnauthenticatedFacilitator !== undefined
        ? { allowUnauthenticatedFacilitator: options.allowUnauthenticatedFacilitator }
        : {}),
    });
    const profile = deployment.profile;
    if (profile.family !== 'evm') {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: "${input.network}" (${profile.displayName}) is not an EVM network; this provider settles \`exact\` on EVM only`,
      );
    }
    // Refuse offers mixing local, testnet and mainnet deployment modes
    if (mode !== undefined && deployment.mode !== mode) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: offers mix ${mode} and ${deployment.mode} networks; every offer must be on a ${mode} network`,
      );
    }
    mode = deployment.mode;
    const key = `${input.network}|${input.asset.toLowerCase()}|${input.payTo.toLowerCase()}`;
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

    return {
      network: input.network as Network,
      profile,
      asset: input.asset,
      assetName: input.assetName,
      assetVersion: input.assetVersion,
      assetDecimals: input.assetDecimals,
      payTo: input.payTo,
      // health() reads the chain through its own client, whose timeout aborts
      // the request. Verification and settlement go through the facilitator
      // instead. Health details can reach logs, so they name the RPC by origin.
      rpcOrigin: describeRpc(input.rpcUrl),
      healthClient: createLocalPublicClient(input.rpcUrl, HEALTH_TIMEOUT_MS, profile.chainId),
      binding,
    };
  });
  const deploymentMode = mode as DeploymentMode;

  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? DEFAULT_IDS;
  const logger = options.logger ?? NOOP_LOGGER;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;

  const descriptor: AdapterDescriptor = {
    name: 'x402',
    kind: 'payment',
    implementationVersion: PACKAGE_VERSION,
    supportedSpec: `x402/v${X402_VERSION} scheme=exact family=eip155`,
    capabilities: [
      'exact-evm',
      `${options.facilitator.mode}-facilitator`,
      'eip-3009',
      'caip-2',
      `mode=${deploymentMode}`,
      'authorization-flow',
      'upfront-flow',
      ...(offers.length > 1 ? ['multiple-offers'] : []),
    ],
    status: 'stable',
    unsupported: [
      'svm',
      'permit2',
      'upto scheme',
      'batch-settlement scheme',
      'auth-capture scheme',
    ],
  };

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

    const accepts: PaymentRequirements[] = offers.map((offer) => ({
      scheme: 'exact',
      network: offer.network,
      asset: offer.asset,
      amount: parseCanonicalAmount(context.amount, offer.assetDecimals).toString(),
      payTo: offer.payTo,
      maxTimeoutSeconds,
      // `name`/`version` let the buyer and the facilitator build the same
      // EIP-712 domain without calling `version()` on the token.
      // `assetTransferMethod` names the one method this provider settles, so a
      // conforming client never picks the `exact` scheme's Permit2 path.
      // x402 requires an explicit non-default flow. Omit the default
      // `authorization` flow here.
      extra: {
        name: offer.assetName,
        version: offer.assetVersion,
        assetTransferMethod: 'eip3009',
        ...(paymentFlow === 'upfront' ? { paymentFlow } : {}),
      },
    }));
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
      metadata: { [SETTLE_AFTER_BACKEND_METADATA_KEY]: paymentFlow === 'authorization' },
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
      acceptedMatchesOffer(offer, payload.accepted) ? [index] : [],
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
    // request, so this rarely fires. The real expiry is EIP-3009's
    // `validBefore`, which the facilitator checks.
    if (
      requirement.expiresAt !== undefined &&
      Date.parse(requirement.expiresAt) < clock.now().getTime()
    ) {
      return rejected('requirement_expired');
    }

    // This provider built the requirement, so the asset always matches in
    // normal operation. A corrupted one must still never authorize a transfer
    // of a different asset.
    if (
      !isAddress(requirements.asset) ||
      getAddress(requirements.asset) !== getAddress(offer.asset)
    ) {
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
    if (!isExactEvmPayload(payload)) {
      return rejected('unsupported_scheme');
    }

    const { authorization } = payload.payload;

    if (!isAddress(authorization.from) || !isAddress(authorization.to)) {
      return rejected('invalid_payload');
    }
    // `accepted.network` names the chain the buyer signed for, so a mismatch
    // means a signature bound to a chain we do not settle on
    if (payload.accepted.network !== offer.network) {
      return rejected('invalid_network');
    }
    // The signature omits flow and resource. Check the echoed offer;
    // `resource` is optional, but must match when present.
    const offeredUrl = (requirement.challenge.envelope as PaymentRequired | undefined)?.resource
      ?.url;
    if (
      !acceptedMatchesOffer(requirements, payload.accepted) ||
      (payload.resource !== undefined && payload.resource.url !== offeredUrl)
    ) {
      return rejected('invalid_payment_requirements');
    }
    if (getAddress(authorization.to) !== getAddress(offer.payTo)) {
      return rejected('invalid_exact_evm_payload_recipient_mismatch');
    }
    let authorizedValue: bigint;
    let required: bigint;
    try {
      authorizedValue = BigInt(authorization.value);
      required = BigInt(requirements.amount);
    } catch {
      return rejected('invalid_payload');
    }
    if (authorizedValue !== required) {
      return rejected('invalid_exact_evm_payload_authorization_value_mismatch');
    }

    const scope = offer.binding.open();
    let sdkResult: VerifyResponse;
    try {
      sdkResult = await scope.verify(withoutResource(payload), requirements);
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
      if (scope.transportFailed()) {
        if (sdkResult.invalidReason !== undefined) {
          logger.debug(
            { reportedReason: sdkResult.invalidReason },
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
          { reportedReason: sdkResult.invalidReason },
          'x402 verify(): facilitator rejection reason',
        );
      }
      return rejected(sanitizeReason(sdkResult.invalidReason, 'invalid_payment'));
    }

    // `accepted.network` equals the offer's network (checked above), so its
    // chain id is the one the authorization is bound to
    const replayKey = computeReplayKey({
      chainId: offer.profile.chainId,
      asset: getAddress(requirements.asset),
      from: getAddress(authorization.from),
      nonce: authorization.nonce,
    });

    return {
      status: 'verified',
      provider: 'x402',
      payer: getAddress(authorization.from),
      payee: getAddress(authorization.to),
      amount: formatUnits(authorizedValue, offer.assetDecimals),
      currency: requirement.currency,
      network: payload.accepted.network,
      asset: getAddress(requirements.asset),
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
    if (!payload || !isExactEvmPayload(payload)) {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'x402 provider: settle() received an undecodable payment payload',
      );
    }

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
      sdkResult = await scope.settle(withoutResource(payload), requirements);
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

    if (!sdkResult.success) {
      // "Broadcast, never confirmed" is not "did not happen": the transfer may
      // be on-chain, so it throws as an unavailable provider carrying the hash,
      // and the pipeline records the attempt `settlement-uncertain`, not
      // `rejected`. The SDK's catch-all without a hash is treated the same way,
      // because its throw may have followed a broadcast and viem reports an
      // RPC error on the send as a revert. Everything else is a real rejection.
      if (
        sdkResult.errorReason === TRANSACTION_FAILED_REASON &&
        !/^0x[0-9a-f]{64}$/i.test(sdkResult.transaction)
      ) {
        logger.warn(
          { reportedReason: sdkResult.errorReason },
          'x402 settle(): the broadcast failed without a transaction hash; outcome unknown',
        );
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: settlement failed with an unclassified error; outcome unknown',
        );
      }
      if (sdkResult.errorReason === SETTLEMENT_PENDING_REASON || scope.transportFailed()) {
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
      if (sdkResult.errorReason !== undefined) {
        logger.debug(
          { reportedReason: sdkResult.errorReason },
          'x402 settle(): facilitator failure reason',
        );
      }
      return {
        ...rejectedSettlement(sanitizeReason(sdkResult.errorReason, 'settlement_failed')),
        network: sdkResult.network,
        ...(sdkResult.payer !== undefined ? { payer: sdkResult.payer } : {}),
      };
    }

    return {
      status: 'settled',
      provider: 'x402',
      externalReference: sdkResult.transaction,
      ...(sdkResult.payer !== undefined ? { payer: sdkResult.payer } : {}),
      payee: requirements.payTo,
      amount: verification.amount,
      currency: requirement.currency,
      network: sdkResult.network,
      ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
      ...(verification.replayKey !== undefined ? { replayKey: verification.replayKey } : {}),
      settledAt: clock.nowIso(),
      // `amount` is the display value; x402's settlement response reports base units
      metadata: { amountBaseUnits: payload.payload.authorization.value },
    };
  }

  // One offer's chain, asset and facilitator support. `kinds` fetches the
  // remote facilitator's `/supported` once per probe, shared by every offer.
  async function offerHealth(
    offer: Offer,
    kinds: () => Promise<readonly SupportedKind[]>,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
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
          `${profile.chainId} (${profile.displayName}), asset ${offer.asset} has code, ` +
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
        `${profile.chainId}, asset ${offer.asset} has code, confirmed Anvil dev node`,
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

/**
 * Match echoed terms against the offer. Extra client keys and
 * `maxTimeoutSeconds` do not matter; addresses ignore case. Compare effective
 * payment flows so an upfront proof cannot pay a default authorization offer.
 */
function acceptedMatchesOffer(
  offered: PaymentRequirements,
  accepted: PaymentRequirements,
): boolean {
  const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const offeredExtra = offered.extra ?? {};
  const acceptedExtra = accepted.extra ?? {};
  const flow = (extra: Record<string, unknown>) =>
    extra['paymentFlow'] ?? X402_DEFAULT_PAYMENT_FLOW;
  return (
    accepted.scheme === offered.scheme &&
    accepted.network === offered.network &&
    accepted.amount === offered.amount &&
    sameAddress(accepted.asset, offered.asset) &&
    sameAddress(accepted.payTo, offered.payTo) &&
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
