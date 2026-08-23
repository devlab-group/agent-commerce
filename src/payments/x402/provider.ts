/**
 * x402 payment provider — protocol version 2, `exact` scheme, EVM,
 * EIP-3009 `transferWithAuthorization`.
 *
 * Implements the frozen `PaymentProvider` interface (src/core/domain/payment.ts).
 * `verify()` never moves funds; only `settle()` does, and only after a
 * successful `verify()` (enforced by the gateway's execution pipeline, not by
 * this file, but this file never calls settle-like RPCs from verify()).
 *
 * Verification and settlement run through the SDK's own `x402Facilitator`
 * with the `exact`/EVM scheme registered against a single CAIP-2 network. The
 * facilitator is in-process — it is the same code a hosted facilitator runs,
 * pointed at the local dev chain — so there is no network hop and no third
 * party in the settlement path.
 *
 * The SDK behaviour relied on here is verified, not assumed: see the notes
 * beside each call site below.
 */

import type {
  Network,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
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
} from '../../core/index.js';
import { PACKAGE_VERSION } from '../../version.js';
import { formatCanonicalAmount, parseCanonicalAmount } from './amount.js';
import {
  chainIdFromCaip2,
  createLocalFacilitatorClient,
  createLocalPublicClient,
  type LocalFacilitatorClient,
} from './chain.js';
import { assertDevKeyIsLocalOnly, assertPayToIsNotDevAddress } from './dev-key-guard.js';
import {
  createLocalFacilitatorBinding,
  createRemoteFacilitatorBinding,
  type FacilitatorBinding,
} from './facilitator.js';
import { resolveX402Deployment, type X402FacilitatorConfig } from './guardrails.js';
import { describeDeploymentMode } from './networks.js';
import { decodePaymentSubmission, isExactEvmPayload } from './payload.js';
import { computeReplayKey } from './replay-key.js';

const X402_VERSION = 2;
const X402_PROTOCOL_VERSION = String(X402_VERSION);
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MIME_TYPE = 'application/json';
const HEALTH_TIMEOUT_MS = 4_000;
/** `SettleResponse.errorReason` the SDK uses for "broadcast, not confirmed". */
const SETTLEMENT_PENDING_REASON = 'settlement_pending';

export interface X402ProviderOptions {
  /**
   * CAIP-2 network identifier, e.g. `eip155:84532`. The chain id it carries is
   * part of the EIP-712 domain the buyer signs, so it is read from this value
   * rather than defaulted.
   */
  readonly network: string;
  /** RPC endpoint. Local chain: http://127.0.0.1:8545 */
  readonly rpcUrl: string;
  /** ERC-20 (EIP-3009) asset address used for settlement. */
  readonly asset: `0x${string}`;
  /** EIP-712 domain name of the asset, e.g. 'MockUSDC'. */
  readonly assetName: string;
  /** EIP-712 domain version of the asset, e.g. '2'. */
  readonly assetVersion: string;
  readonly assetDecimals: number;
  /** Merchant-controlled settlement destination. Never a gateway-owned wallet. */
  readonly payTo: `0x${string}`;
  readonly maxTimeoutSeconds?: number;
  /**
   * Which facilitator verifies and broadcasts.
   *
   * `local` runs the facilitator in this process against the dev chain, and
   * its `signerPrivateKey` must be an Anvil well-known key — LOCAL DEVELOPMENT
   * ONLY — DO NOT FUND. `remote` calls an HTTP facilitator, and this gateway
   * then holds no signing key at all.
   */
  readonly facilitator: X402FacilitatorConfig;
  /**
   * Required to be `true` before anything settles on a mainnet. Never a
   * default — see `guardrails.ts`.
   */
  readonly allowMainnet?: boolean;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

const DEFAULT_IDS: IdGenerator = {
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
  // Applies regardless of facilitator.mode — which account signs settlement
  // has no bearing on whether the destination address's private key is
  // public knowledge. `resolveX402Deployment` below covers the other half of
  // the same question: a dev payTo on any non-local *deployment*, where the
  // RPC host says nothing about where the money lands.
  assertPayToIsNotDevAddress(options.rpcUrl, options.payTo);
  if (!Number.isInteger(options.assetDecimals) || options.assetDecimals < 0) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: "assetDecimals" must be a non-negative integer`,
    );
  }
  // The chain id is not a display detail: it is signed into the buyer's
  // EIP-712 domain, so a network identifier we cannot resolve one from is a
  // startup failure, never a request-time default. `resolveX402Deployment`
  // also decides what this deployment *is* — local, testnet or mainnet — and
  // refuses every combination that could move real money by accident.
  const { profile, mode } = resolveX402Deployment({
    network: options.network,
    payTo: options.payTo,
    asset: options.asset,
    facilitator: options.facilitator,
    ...(options.allowMainnet !== undefined ? { allowMainnet: options.allowMainnet } : {}),
  });
  const network = options.network as Network;
  // Constructed once, here, rather than inside settle(): assertDevKeyIsLocalOnly
  // above already proves the key is well-formed, so privateKeyToAccount is not
  // expected to throw — but if it somehow does (or the key/RPC combination is
  // otherwise unusable), that is a *configuration* problem, and a bad key
  // should fail the provider at startup, not on the first paying customer's
  // request, after their replayKey is already reserved. This mirrors the other
  // CONFIG_INVALID checks above, which are all one-time, construction-time
  // validation rather than per-request checks.
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
          'facilitator.signerPrivateKey — it must be a valid 32-byte hex private key',
        { cause },
      );
    }
    binding = createLocalFacilitatorBinding(client, network, isProviderUnavailableError);
  } else {
    binding = createRemoteFacilitatorBinding(
      { url: options.facilitator.url, auth: options.facilitator.auth },
      isProviderUnavailableError,
    );
  }

  // health()'s own read-only client, with a real transport-level timeout (see
  // createLocalPublicClient's doc comment). Verification and settlement read
  // the chain through the facilitator signer instead, so this is the only
  // public client the provider builds.
  const healthPublicClient = createLocalPublicClient(options.rpcUrl, HEALTH_TIMEOUT_MS);

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
    unsupported: [
      'svm',
      'permit2',
      'upto scheme',
      'per-request signed facilitator credentials (e.g. CDP JWT)',
    ],
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
      // `name`/`version` are what let a buyer and the facilitator build the
      // same EIP-712 domain without an on-chain `version()` call, so
      // verification stays deterministic against a token that has none.
      //
      // `assetTransferMethod` is stated rather than left to default: x402 v2's
      // `exact`/EVM scheme also has a Permit2 path, and a client that picked it
      // would produce a payload this provider cannot settle. Declaring the one
      // supported method turns that into a client-side non-choice instead of a
      // server-side rejection.
      extra: {
        name: options.assetName,
        version: options.assetVersion,
        assetTransferMethod: 'eip3009',
      },
    };

    // The v2 challenge document, verbatim on the wire: the HTTP adapter
    // base64-encodes this into `PAYMENT-REQUIRED`, and MCP passes it through
    // in the payment-required envelope. Built once, here, so both surfaces
    // describe the same challenge rather than each assembling their own.
    //
    // `resource.url` is descriptive metadata: nothing in the EIP-3009
    // authorisation (`from`/`to`/`value`/`validAfter`/`validBefore`/`nonce`)
    // covers it, nothing verifies against it, and the replay key is keyed on
    // the authorisation instead. It still carries `network` and `payTo` —
    // both already public in this same challenge — because the
    // `agent-commerce` authority is not reserved to us across the wider x402
    // ecosystem, so the pair is what keeps it unambiguous.
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
   * Verifies a payment submission against a payment requirement.
   *
   * Every check below runs against *our* requirement — the one this provider
   * built and the pipeline held onto — never against `payload.accepted`, the
   * copy of the requirements the client echoes back. That echo is attacker
   * data; the SDK's scheme facilitator likewise takes the requirements as an
   * explicit argument rather than reading them off the payload.
   *
   * Deliberately accepts overpayment: only `authorizedValue < required` is
   * rejected (`wrong_amount`), never `authorizedValue > required`. This
   * matches x402's own semantics — the requirement's `amount` names a floor,
   * not an exact amount — and the settled `PaymentResult.amount` always
   * records the actual authorised value, so bookkeeping stays truthful to what
   * really moved rather than silently topping up or rejecting a generous
   * buyer.
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

    // Defence in depth, not the real expiry: the pipeline calls
    // createRequirement() fresh on every request, so by the time verify()
    // runs this requirement is only ever seconds old — this check will
    // essentially never fire in the current flow. The actual expiry
    // enforcement is EIP-3009's validBefore, checked inside the SDK's scheme
    // facilitator. Kept because it is cheap and correct, not because it is
    // load-bearing.
    if (
      requirement.expiresAt !== undefined &&
      Date.parse(requirement.expiresAt) < clock.now().getTime()
    ) {
      return rejected('requirement_expired');
    }

    // Defensive invariant: the requirement we're verifying against must still
    // describe *this* provider's configured asset. It always will in normal
    // operation (we generated it), but a corrupted/mismatched requirement
    // must never be allowed to authorise a transfer for a different asset.
    if (
      !isAddress(requirements.asset) ||
      getAddress(requirements.asset) !== getAddress(options.asset)
    ) {
      return rejected('wrong_asset');
    }

    const payload = decodePaymentSubmission(submission.payload);
    if (!payload) {
      return rejected('malformed_payment_payload');
    }
    if (payload.x402Version !== X402_VERSION) {
      return rejected('unsupported_x402_version');
    }
    if (!isExactEvmPayload(payload)) {
      return rejected('unsupported_scheme');
    }

    const { authorization } = payload.payload;

    if (!isAddress(authorization.from) || !isAddress(authorization.to)) {
      return rejected('malformed_payment_payload');
    }
    // The network the buyer signed for is `accepted.network` — it is what the
    // scheme derives the EIP-712 chain id from — so a mismatch here means the
    // signature is bound to a different chain than the one we settle on.
    if (payload.accepted.network !== options.network) {
      return rejected('wrong_network');
    }
    if (getAddress(authorization.to) !== getAddress(options.payTo)) {
      return rejected('wrong_recipient');
    }
    let authorizedValue: bigint;
    let required: bigint;
    try {
      authorizedValue = BigInt(authorization.value);
      required = BigInt(requirements.amount);
    } catch {
      return rejected('malformed_payment_payload');
    }
    if (authorizedValue < required) {
      return rejected('wrong_amount'); // overpayment is allowed through — see the doc comment above
    }

    const scope = binding.open();
    let sdkResult: VerifyResponse;
    try {
      sdkResult = await scope.verify(payload, requirements);
    } catch (err) {
      if (isProviderUnavailableError(err) || scope.transportFailed()) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          `x402 provider: ${binding.kind} facilitator unreachable during verify()`,
          {
            cause: err,
          },
        );
      }
      logger.warn({ err: describeError(err) }, 'x402 verify(): unexpected SDK error');
      return rejected('unexpected_verify_error');
    }

    if (!sdkResult.isValid) {
      // An RPC that never answered is not a payment that failed a check.
      if (scope.transportFailed()) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          `x402 provider: ${binding.kind} facilitator unreachable during verify()`,
          { details: { reportedReason: sdkResult.invalidReason ?? 'invalid_payment' } },
        );
      }
      return rejected(sdkResult.invalidReason ?? 'invalid_payment');
    }

    // Derived from the chain id the authorisation is actually bound to, never
    // from a provider-instance constant, so the key stays correct the moment
    // there is more than one chain id in play.
    const payloadChainId = chainIdFromCaip2(payload.accepted.network);
    if (payloadChainId === undefined) {
      return rejected('wrong_network');
    }
    const replayKey = computeReplayKey({
      chainId: payloadChainId,
      asset: getAddress(requirements.asset),
      from: getAddress(authorization.from),
      nonce: authorization.nonce,
    });

    return {
      status: 'verified',
      provider: 'x402',
      payer: getAddress(authorization.from),
      payee: getAddress(authorization.to),
      amount: formatCanonicalAmount(authorizedValue, options.assetDecimals),
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
      const rejectionReason = isOnChainRevertError(err)
        ? 'transaction_reverted'
        : 'unexpected_settle_error';
      logger.warn(
        { err: describeError(err), rejectionReason },
        'x402 settle(): settlement transaction failed',
      );
      return rejectedSettlement(rejectionReason);
    }

    if (!sdkResult.success) {
      // "Broadcast, never confirmed" is not "did not happen": the transfer may
      // already be on-chain, so it surfaces as an *unavailable* provider
      // carrying the hash, letting the pipeline record
      // the attempt `settlement-uncertain` rather than `failed` and the payer
      // is told which transaction to check. Everything else is a real
      // rejection.
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
      return {
        ...rejectedSettlement(sdkResult.errorReason ?? 'settlement_failed'),
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
          detail: `RPC at ${options.rpcUrl} reports chain id ${chainId}, expected ${profile.chainId} (${profile.displayName})`,
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
        // "Reachable" is not the question — "will it settle *this*" is. A
        // facilitator that is up but does not carry our scheme on our network
        // fails every payment, and does it after the buyer has signed.
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
            `${describeDeploymentMode(mode)} — RPC ${options.rpcUrl} reachable, chain id ` +
            `${profile.chainId} (${profile.displayName}), asset ${options.asset} has code, ` +
            `facilitator ${binding.describe} supports exact/${options.network}`,
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      // Chain id alone cannot prove this is a dev chain: real Base Sepolia
      // reports the same id (84532) as this project's local chain, by design.
      // Probe an Anvil-only RPC method — present only on a real Anvil node —
      // before trusting a well-known dev key against it.
      const isAnvil = await probeIsAnvilNode(healthPublicClient);
      if (!isAnvil) {
        return {
          status: 'fail',
          detail:
            `RPC at ${options.rpcUrl} reports chain id ${profile.chainId} but does not answer ` +
            '"anvil_nodeInfo" — it does not look like a local Anvil dev node. Refusing to treat it ' +
            'as safe for a local-facilitator dev key.',
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      return {
        status: 'pass',
        detail:
          `${describeDeploymentMode(mode)} — RPC ${options.rpcUrl} reachable, chain id ` +
          `${profile.chainId}, asset ${options.asset} has code, confirmed Anvil dev node`,
        checkedAt,
        durationMs: clock.monotonicMs() - startedAt,
      };
    } catch (err) {
      return {
        status: 'fail',
        detail: `x402 health check failed: ${describeError(err)}`,
        checkedAt,
        durationMs: clock.monotonicMs() - startedAt,
      };
    }
  }

  // /ready has no auth, no cache and no
  // rate limit, and called computeHealth() — 3 live RPC calls — on every
  // single request; measured 3x amplification of billed upstream calls
  // under an unauthenticated flood. Memoise behind a short TTL and collapse
  // concurrent callers onto one in-flight probe, so N requests within the
  // window produce at most one round-trip instead of N.
  //
  // 5s: short enough that a readiness probe (Kubernetes' own default
  // `periodSeconds` is 10s) never observes data older than its own poll
  // interval, long enough to fully decouple RPC call volume from HTTP
  // request volume — which is the property that closes the amplification,
  // not the exact number of seconds.
  //
  // pass and fail are cached for the same TTL, deliberately: a shorter TTL
  // for fail would re-introduce the amplification exactly when an upstream
  // outage makes every call expensive/slow, which is the worst possible time
  // to remove the cache's protection. 5s of recovery latency after the RPC
  // comes back is an acceptable trade — it is already within the noise of a
  // single health probe's own round-trip time, and well inside a normal
  // probe's own poll interval.
  //
  // This only memoises this provider's own RPC probe. `core` separately
  // memoises the whole /ready aggregation (src/gateway/readiness.ts)
  // — a second, independent layer at a different scope; the two compose
  // without conflict since neither assumes anything about the other's TTL.
  //
  // Does not affect `doctor`'s deployment-mismatch cross-check: that reads
  // asset/network/payTo straight from `/.well-known/agent-commerce` (static
  // provider config, echoed live, never cached), not from health().
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

function isOnChainRevertError(err: unknown): boolean {
  return (
    err instanceof ContractFunctionRevertedError || err instanceof ContractFunctionExecutionError
  );
}

/**
 * `instanceof` checks first — these are the real error classes the pinned
 * viem@2.55.18 HTTP transport throws (see viem's `utils/rpc/http.js`, which
 * wraps every fetch failure, including connection-refused, in
 * `HttpRequestError` unless it is already a `TimeoutError`), plus the error
 * `waitForTransactionReceipt` itself throws when it gives up polling for a
 * receipt — precisely the "broadcast succeeded, confirmation didn't" case
 * this classification exists to catch. Substring matching
 * is kept only as a fallback for shapes not covered by a typed viem class
 * (e.g. a raw Node/undici error surfacing through some other path) — pinning
 * behaviour to message text is brittle across viem/undici upgrades, so the
 * instanceof checks should be preferred and grown over time as more real
 * failure shapes are seen.
 */
function isProviderUnavailableError(err: unknown): boolean {
  if (
    err instanceof HttpRequestError ||
    err instanceof TimeoutError ||
    err instanceof WaitForTransactionReceiptTimeoutError
  ) {
    return true;
  }
  const message = describeError(err).toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('fetch failed') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('timed out') ||
    message.includes('network error')
  );
}

/** Never includes secrets: only error class name + message, never raw payloads or keys. */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * True only when the RPC answers Anvil's own `anvil_nodeInfo` method — a
 * real network (including real Base Sepolia, which shares chain id 84532
 * with this project's local chain by design) returns a JSON-RPC "method
 * not found" error instead. Never throws.
 */
async function probeIsAnvilNode(
  client: ReturnType<typeof createLocalPublicClient>,
): Promise<boolean> {
  // Anvil-only method: not part of viem's typed PublicRpcSchema, hence the cast.
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
