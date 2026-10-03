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
import { PACKAGE_VERSION } from '../../version';
import { parseCanonicalAmount } from './amount';
import {
  createLocalFacilitatorClient,
  createLocalPublicClient,
  type LocalFacilitatorClient,
} from './chain';
import { assertDevKeyIsLocalOnly, assertPayToIsNotDevAddress, describeRpc } from './dev-key-guard';
import {
  createLocalFacilitatorBinding,
  createRemoteFacilitatorBinding,
  type FacilitatorBinding,
} from './facilitator';
import { resolveX402Deployment, type X402FacilitatorConfig } from './guardrails';
import { describeDeploymentMode } from './networks';
import { decodePaymentSubmission, isExactEvmPayload } from './payload';
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
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/** Prefixed random UUIDs, shared with the MPP rail */
export const DEFAULT_IDS: IdGenerator = {
  next: (prefix?: string) => `${prefix ? `${prefix}_` : ''}${crypto.randomUUID()}`,
};

export function createX402PaymentProvider(options: X402ProviderOptions): PaymentProvider {
  if (!isAddress(options.asset)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: "asset" is not a valid EVM address: ${options.asset}`,
    );
  }
  if (!isAddress(options.payTo)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: "payTo" is not a valid EVM address: ${options.payTo}`,
    );
  }
  // In every facilitator mode. `resolveX402Deployment` below also refuses a dev
  // payTo on any non-local deployment, whatever the RPC host.
  assertPayToIsNotDevAddress(options.rpcUrl, options.payTo);
  if (!Number.isInteger(options.assetDecimals) || options.assetDecimals < 0) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: "assetDecimals" must be a non-negative integer`,
    );
  }
  // The chain id is signed into the buyer's EIP-712 domain, so a network it
  // cannot be resolved from fails here, never at request time
  const { profile, mode } = resolveX402Deployment({
    network: options.network,
    payTo: options.payTo,
    asset: options.asset,
    assetName: options.assetName,
    assetVersion: options.assetVersion,
    facilitator: options.facilitator,
    ...(options.allowMainnet !== undefined ? { allowMainnet: options.allowMainnet } : {}),
    ...(options.allowUnauthenticatedFacilitator !== undefined
      ? { allowUnauthenticatedFacilitator: options.allowUnauthenticatedFacilitator }
      : {}),
  });
  const network = options.network as Network;
  // Built once, here, rather than in settle(): an unusable key fails the
  // provider at startup, not on the first paid request after that buyer's
  // replay key is already reserved
  let binding: FacilitatorBinding;
  if (options.facilitator.mode === 'local') {
    assertDevKeyIsLocalOnly(options.rpcUrl, options.facilitator.signerPrivateKey);
    let client: LocalFacilitatorClient;
    try {
      client = createLocalFacilitatorClient(
        options.rpcUrl,
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
    binding = createLocalFacilitatorBinding(client, network, isProviderUnavailableError);
  } else {
    binding = createRemoteFacilitatorBinding({
      url: options.facilitator.url,
      auth: options.facilitator.auth,
    });
  }

  // health() reads the chain through its own client, whose timeout aborts the
  // request. Verification and settlement go through the facilitator instead.
  // Health details can reach logs, so they name the RPC by origin only.
  const rpcOrigin = describeRpc(options.rpcUrl);
  const healthPublicClient = createLocalPublicClient(
    options.rpcUrl,
    HEALTH_TIMEOUT_MS,
    profile.chainId,
  );

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
      `${binding.kind}-facilitator`,
      'eip-3009',
      'caip-2',
      `mode=${mode}`,
    ],
    status: 'stable',
    unsupported: ['svm', 'permit2', 'upto scheme', 'deferred scheme'],
  };

  async function createRequirement(context: PaymentContext): Promise<PaymentRequirement> {
    const amount = parseCanonicalAmount(context.amount, options.assetDecimals).toString();

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network,
      asset: options.asset,
      amount,
      payTo: options.payTo,
      maxTimeoutSeconds,
      // `name`/`version` let the buyer and the facilitator build the same
      // EIP-712 domain without calling `version()` on the token.
      // `assetTransferMethod` names the one method this provider settles, so a
      // conforming client never picks the `exact` scheme's Permit2 path.
      // The pipeline settles before calling the backend, so declare the
      // non-default `upfront` flow: backend failure can follow payment
      extra: {
        name: options.assetName,
        version: options.assetVersion,
        assetTransferMethod: 'eip3009',
        paymentFlow: 'upfront',
      },
    };

    // The v2 challenge document as sent on the wire. The HTTP adapter
    // base64-encodes it into `PAYMENT-REQUIRED` and MCP passes it through, so
    // both surfaces offer the same challenge.
    //
    // `resource.url` is descriptive: the EIP-3009 authorization does not cover
    // it and nothing verifies against it. It carries `network` and `payTo`,
    // both already public in the challenge, because other x402 servers may use
    // the `agent-commerce` authority too.
    const envelope: PaymentRequired = {
      x402Version: X402_VERSION,
      resource: {
        url: `resource://agent-commerce/${encodeURIComponent(options.network)}/${options.payTo}/resources/${encodeURIComponent(context.resource.id)}`,
        description: context.resource.description ?? context.resource.name,
        mimeType: DEFAULT_MIME_TYPE,
      },
      accepts: [requirements],
    };

    const expiresAt = new Date(clock.now().getTime() + maxTimeoutSeconds * 1000).toISOString();

    return {
      id: ids.next('payreq'),
      requestId: context.requestId,
      resourceId: context.resource.id,
      provider: 'x402',
      amount: context.amount,
      currency: context.currency,
      destination: options.payTo,
      network: options.network,
      asset: options.asset,
      expiresAt,
      challenge: {
        provider: 'x402',
        version: X402_PROTOCOL_VERSION,
        accepts: [requirements as unknown as Record<string, unknown>],
        envelope: envelope as unknown as Record<string, unknown>,
      },
    };
  }

  /**
   * Checks a submission against the requirement this provider built, never
   * against `payload.accepted`, the copy the client echoes back.
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

    const requirements = requirement.challenge.accepts[0] as PaymentRequirements | undefined;
    if (!requirements) {
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
      getAddress(requirements.asset) !== getAddress(options.asset)
    ) {
      return rejected('wrong_asset');
    }

    const payload = decodePaymentSubmission(submission.payload);
    if (!payload) {
      return rejected('invalid_payload');
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
    if (payload.accepted.network !== options.network) {
      return rejected('invalid_network');
    }
    if (getAddress(authorization.to) !== getAddress(options.payTo)) {
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

    const scope = binding.open();
    let sdkResult: VerifyResponse;
    try {
      sdkResult = await scope.verify(payload, requirements);
    } catch (err) {
      // A throw means no verdict was obtained, so it is never held against the
      // buyer. Only an unclassified one is logged, as it may be an SDK fault.
      if (!isProviderUnavailableError(err) && !scope.transportFailed()) {
        logger.warn({ err: redactedErrorText(err) }, 'x402 verify(): unexpected SDK error');
      }
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `x402 provider: ${binding.kind} facilitator returned no verdict during verify()`,
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
          `x402 provider: ${binding.kind} facilitator unreachable during verify()`,
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

    // `accepted.network` equals the configured network (checked above), so the
    // profile's chain id is the one the authorization is bound to
    const replayKey = computeReplayKey({
      chainId: profile.chainId,
      asset: getAddress(requirements.asset),
      from: getAddress(authorization.from),
      nonce: authorization.nonce,
    });

    return {
      status: 'verified',
      provider: 'x402',
      payer: getAddress(authorization.from),
      payee: getAddress(authorization.to),
      amount: formatUnits(authorizedValue, options.assetDecimals),
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

    const requirements = requirement.challenge.accepts[0] as PaymentRequirements | undefined;
    if (!requirements) {
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

    const scope = binding.open();
    let sdkResult: SettleResponse;
    try {
      sdkResult = await scope.settle(payload, requirements);
    } catch (err) {
      if (isProviderUnavailableError(err) || scope.transportFailed()) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          `x402 provider: ${binding.kind} facilitator unreachable during settle()`,
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
    };
  }

  async function computeHealth(): Promise<AdapterHealth> {
    const startedAt = clock.monotonicMs();
    const checkedAt = clock.nowIso();

    try {
      const chainId = await healthPublicClient.getChainId();
      if (chainId !== profile.chainId) {
        return {
          status: 'fail',
          detail: `RPC at ${rpcOrigin} reports chain id ${chainId}, expected ${profile.chainId} (${profile.displayName})`,
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      const code = await healthPublicClient.getCode({ address: options.asset });
      if (!code || code === '0x') {
        return {
          status: 'fail',
          detail: `No contract code found at configured asset address ${options.asset}`,
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      if (binding.kind === 'remote') {
        // Reachable is not enough: a facilitator that does not carry our
        // scheme on our network fails every payment after the buyer has signed
        const kinds = await binding.supported();
        const supportsUs = kinds.some(
          (kind) =>
            kind.x402Version === X402_VERSION &&
            kind.scheme === 'exact' &&
            kind.network === options.network,
        );
        if (!supportsUs) {
          return {
            status: 'fail',
            detail:
              `Facilitator ${binding.describe} does not advertise x402 v${X402_VERSION} scheme=exact ` +
              `on ${options.network} (${profile.displayName}); no payment on this deployment can settle`,
            checkedAt,
            durationMs: clock.monotonicMs() - startedAt,
          };
        }
        return {
          status: 'pass',
          detail:
            `${describeDeploymentMode(mode)}: RPC ${rpcOrigin} reachable, chain id ` +
            `${profile.chainId} (${profile.displayName}), asset ${options.asset} has code, ` +
            `facilitator ${binding.describe} supports exact/${options.network}`,
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      // Chain id alone cannot prove this is a dev chain, because Base Sepolia
      // reports the same 84532 as the local chain. An Anvil-only RPC method
      // must answer before a local facilitator counts as healthy.
      const isAnvil = await probeIsAnvilNode(healthPublicClient);
      if (!isAnvil) {
        return {
          status: 'fail',
          detail:
            `RPC at ${rpcOrigin} reports chain id ${profile.chainId} but does not answer ` +
            '"anvil_nodeInfo", so it does not look like a local Anvil dev node. Refusing to treat it ' +
            'as safe for a local-facilitator dev key.',
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      return {
        status: 'pass',
        detail:
          `${describeDeploymentMode(mode)}: RPC ${rpcOrigin} reachable, chain id ` +
          `${profile.chainId}, asset ${options.asset} has code, confirmed Anvil dev node`,
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
    verify,
    settle,
    health,
  };
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
