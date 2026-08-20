/**
 * x402 payment provider — `exact` scheme, EVM, EIP-3009 `transferWithAuthorization`.
 *
 * Implements the frozen `PaymentProvider` interface (src/core/domain/payment.ts).
 * `verify()` never moves funds; only `settle()` does, and only after a
 * successful `verify()` (enforced by the gateway's execution pipeline, not by
 * this file, but this file never calls settle-like RPCs from verify()).
 *
 * The behaviour of x402@1.2.0 relied on here is verified, not assumed: see the
 * SDK-behaviour notes beside each call site below.
 */

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  getAddress,
  HttpRequestError,
  isAddress,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { settle as x402Settle, verify as x402Verify } from 'x402/facilitator';
import { getNetworkId } from 'x402/shared';
import type { PaymentRequirements } from 'x402/types';
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
  createLocalFacilitatorClient,
  createLocalPublicClient,
  LOCAL_CHAIN_ID,
  type LocalFacilitatorClient,
} from './chain.js';
import { assertDevKeyIsLocalOnly, assertPayToIsNotDevAddress } from './dev-key-guard.js';
import { decodePaymentSubmission, isExactEvmPayload } from './payload.js';
import { computeReplayKey } from './replay-key.js';

const X402_PROTOCOL_VERSION = '1';
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MIME_TYPE = 'application/json';
const HEALTH_TIMEOUT_MS = 4_000;

export interface X402ProviderOptions {
  /** x402 network name. Local deterministic chain uses 'base-sepolia'. */
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
   * Local facilitator: signer broadcasts settlement on the dev chain only.
   * LOCAL DEVELOPMENT ONLY — DO NOT FUND.
   */
  readonly facilitator:
    | { readonly mode: 'local'; readonly signerPrivateKey: `0x${string}` }
    | { readonly mode: 'remote'; readonly url: string };
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
  // public knowledge.
  assertPayToIsNotDevAddress(options.rpcUrl, options.payTo);
  if (!Number.isInteger(options.assetDecimals) || options.assetDecimals < 0) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: "assetDecimals" must be a non-negative integer`,
    );
  }
  // Constructed once, here, rather than inside settle(): assertDevKeyIsLocalOnly
  // above already proves the key is well-formed, so privateKeyToAccount is not
  // expected to throw — but if it somehow does (or the key/RPC combination is
  // otherwise unusable), that is a *configuration* problem, and a bad key
  // should fail the provider at startup, not on the first paying customer's
  // request (after their replayKey is already reserved — see in the
  //. This mirrors the other CONFIG_INVALID checks above,
  // which are all one-time, construction-time validation rather than
  // per-request checks.
  let facilitatorClient: LocalFacilitatorClient | undefined;
  if (options.facilitator.mode === 'local') {
    assertDevKeyIsLocalOnly(options.rpcUrl, options.facilitator.signerPrivateKey);
    try {
      facilitatorClient = createLocalFacilitatorClient(
        options.rpcUrl,
        options.facilitator.signerPrivateKey,
      );
    } catch (cause) {
      throw new CommerceError(
        'CONFIG_INVALID',
        'x402 provider: could not construct a local facilitator signer from ' +
          'facilitator.signerPrivateKey — it must be a valid 32-byte hex private key',
        { cause },
      );
    }
  }

  // Constructed once, alongside facilitatorClient and for the same reason:
  // viem's PublicClient is a stateless transport wrapper (every method call
  // issues its own fresh RPC request — there is no cached chain state to go
  // stale by reusing the object), so building a new one per verify() call was
  // pure allocation with no correctness benefit. Shared safely across
  // concurrent calls, same as facilitatorClient.
  const publicClient = createLocalPublicClient(options.rpcUrl);
  // A second, separate client for health() specifically, with a real
  // transport-level timeout (see createLocalPublicClient's doc comment) —
  // scoped to health() only so verify()'s existing timeout behaviour (and
  // its isProviderUnavailableError classification tests) is untouched.
  const healthPublicClient = createLocalPublicClient(options.rpcUrl, HEALTH_TIMEOUT_MS);

  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? DEFAULT_IDS;
  const logger = options.logger ?? NOOP_LOGGER;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;

  const descriptor: AdapterDescriptor = {
    name: 'x402',
    kind: 'payment',
    implementationVersion: PACKAGE_VERSION,
    supportedSpec: 'x402@1.2.0 scheme=exact family=evm',
    capabilities: ['exact-evm', 'local-facilitator', 'eip-3009'],
    status: 'stable',
    unsupported: ['svm', 'deferred scheme', 'remote facilitator'],
  };

  async function createRequirement(context: PaymentContext): Promise<PaymentRequirement> {
    const maxAmountRequired = parseCanonicalAmount(
      context.amount,
      options.assetDecimals,
    ).toString();

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      // options.network is a canonical free-form string (frozen contract); the
      // x402 SDK's Network union is checked against the live chain in health()
      // and by verify()'s own network-mismatch guard.
      network: options.network as PaymentRequirements['network'],
      maxAmountRequired,
      // Descriptive metadata only: `resource` is not part of the EIP-3009
      // authorisation the buyer signs (`from`/`to`/`value`/`validAfter`/
      // `validBefore`/`nonce`), nothing verifies against it, and the replay
      // key is keyed on the authorisation rather than on this string. It is
      // still what a facilitator, wallet or buyer agent logs and shows, so it
      // carries `network` and `payTo` — both already public in this same
      // challenge — to stay unambiguous across the wider x402 ecosystem,
      // where the `agent-commerce` authority alone is not reserved to us.
      resource: `resource://agent-commerce/${encodeURIComponent(options.network)}/${options.payTo}/resources/${encodeURIComponent(context.resource.id)}`,
      description: context.resource.description ?? context.resource.name,
      mimeType: DEFAULT_MIME_TYPE,
      payTo: options.payTo,
      maxTimeoutSeconds,
      asset: options.asset,
      // REQUIRED.name/version explicitly means
      // the facilitator never needs an on-chain version() call to build the
      // EIP-712 domain, so verification stays deterministic even against a
      // token that has no on-chain version() (it doesn't matter here since
      // MockUSDC has one, but this is what makes the domain unambiguous).
      extra: { name: options.assetName, version: options.assetVersion },
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
      },
    };
  }

  /**
   * Verifies a payment submission against a payment requirement.
   *
   * Deliberately accepts overpayment: only `authorizedValue < maxRequired` is
   * rejected (`wrong_amount`), never `authorizedValue > maxRequired`. This
   * matches x402's own semantics — `maxAmountRequired` names a floor, not an
   * exact amount — and the settled `PaymentResult.amount` always records the
   * actual authorised value, so bookkeeping stays truthful to what really
   * moved rather than silently topping up or rejecting a generous buyer. Not
   * an oversight: see ("noted, no action").
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
    // enforcement is EIP-3009's validBefore, checked inside the x402 SDK
    // (x402Verify below, `validBefore < now + 6s` -> invalid). Kept because
    // it is cheap and correct, not because it is load-bearing (external
    //.
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
    if (!isExactEvmPayload(payload)) {
      return rejected('unsupported_scheme');
    }

    const { authorization } = payload.payload;

    if (!isAddress(authorization.from) || !isAddress(authorization.to)) {
      return rejected('malformed_payment_payload');
    }
    if (payload.network !== options.network) {
      return rejected('wrong_network');
    }
    if (getAddress(authorization.to) !== getAddress(options.payTo)) {
      return rejected('wrong_recipient');
    }
    let authorizedValue: bigint;
    let maxRequired: bigint;
    try {
      authorizedValue = BigInt(authorization.value);
      maxRequired = BigInt(requirements.maxAmountRequired);
    } catch {
      return rejected('malformed_payment_payload');
    }
    if (authorizedValue < maxRequired) {
      return rejected('wrong_amount'); // overpayment is allowed through — see the doc comment above
    }

    let sdkResult: Awaited<ReturnType<typeof x402Verify>>;
    try {
      // x402's own.d.mts bundles a rolled-up copy of viem's `Chain`/`Client`
      // type declarations rather than re-exporting viem's, so TS treats them
      // as nominally distinct from the ones `chain.ts` imports directly even
      // though they describe the same runtime object. Casting to the SDK's
      // own declared parameter type (rather than to `any`) keeps this
      // narrowly scoped to that mismatch.
      sdkResult = await x402Verify(
        publicClient as Parameters<typeof x402Verify>[0],
        payload,
        requirements,
      );
    } catch (err) {
      if (isProviderUnavailableError(err)) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: RPC unreachable during verify()',
          {
            cause: err,
          },
        );
      }
      logger.warn({ err: describeError(err) }, 'x402 verify(): unexpected SDK error');
      return rejected('unexpected_verify_error');
    }

    if (!sdkResult.isValid) {
      return rejected(sdkResult.invalidReason ?? 'invalid_payment');
    }

    // Derived from the verified authorisation's own network, per
    // docs/contracts.md — never a provider-instance constant, so the key
    // stays correct the moment there is more than one chain id in play.
    const replayKey = computeReplayKey({
      chainId: getNetworkId(payload.network),
      asset: getAddress(requirements.asset),
      from: getAddress(authorization.from),
      nonce: authorization.nonce as `0x${string}`,
    });

    return {
      status: 'verified',
      provider: 'x402',
      payer: getAddress(authorization.from),
      payee: getAddress(authorization.to),
      amount: formatCanonicalAmount(authorizedValue, options.assetDecimals),
      currency: requirement.currency,
      network: payload.network,
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

    if (options.facilitator.mode !== 'local' || facilitatorClient === undefined) {
      throw new CommerceError(
        'PROTOCOL_UNSUPPORTED',
        'x402 provider: remote facilitator settlement is not implemented in v0.1.0-alpha; ' +
          'only { mode: "local" } is supported',
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

    // x402's settle() broadcasts (writeContract) then confirms
    // (waitForTransactionReceipt) on this client, but only returns the
    // transaction hash to us on success — if confirmation times out, the hash
    // never leaves the SDK. Intercept waitForTransactionReceipt on a per-call
    // wrapper (never mutate the shared client — settle() can run concurrently)
    // so the hash survives onto PAYMENT_PROVIDER_UNAVAILABLE's details even
    // when the SDK throws before returning it. See.
    let broadcastTxHash: `0x${string}` | undefined;
    const settlementClient: LocalFacilitatorClient = {
      ...facilitatorClient,
      waitForTransactionReceipt: (
        args: Parameters<LocalFacilitatorClient['waitForTransactionReceipt']>[0],
      ) => {
        broadcastTxHash = args.hash;
        return facilitatorClient.waitForTransactionReceipt(args);
      },
    };

    let sdkResult: Awaited<ReturnType<typeof x402Settle>>;
    try {
      sdkResult = await x402Settle(
        settlementClient as Parameters<typeof x402Settle>[0],
        payload,
        requirements,
      );
    } catch (err) {
      if (isProviderUnavailableError(err)) {
        throw new CommerceError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'x402 provider: RPC unreachable during settle()',
          {
            cause: err,
            ...(broadcastTxHash !== undefined
              ? { details: { transactionHash: broadcastTxHash } }
              : {}),
          },
        );
      }
      const rejectionReason = isOnChainRevertError(err)
        ? 'transaction_reverted'
        : 'unexpected_settle_error';
      logger.warn(
        { err: describeError(err), rejectionReason },
        'x402 settle(): settlement transaction failed',
      );
      return {
        status: 'rejected',
        provider: 'x402',
        amount: verification.amount,
        currency: requirement.currency,
        ...(verification.network !== undefined ? { network: verification.network } : {}),
        ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
        ...(verification.replayKey !== undefined ? { replayKey: verification.replayKey } : {}),
        rejectionReason,
      };
    }

    if (!sdkResult.success) {
      return {
        status: 'rejected',
        provider: 'x402',
        amount: verification.amount,
        currency: requirement.currency,
        network: sdkResult.network,
        ...(verification.asset !== undefined ? { asset: verification.asset } : {}),
        ...(sdkResult.payer !== undefined ? { payer: sdkResult.payer } : {}),
        ...(verification.replayKey !== undefined ? { replayKey: verification.replayKey } : {}),
        rejectionReason: sdkResult.errorReason ?? 'settlement_failed',
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
      if (chainId !== LOCAL_CHAIN_ID) {
        return {
          status: 'fail',
          detail: `RPC at ${options.rpcUrl} reports chain id ${chainId}, expected ${LOCAL_CHAIN_ID}`,
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

      if (options.facilitator.mode === 'remote') {
        return {
          status: 'warn',
          detail:
            'RPC and asset are reachable; remote facilitator mode is not implemented in v0.1.0-alpha',
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      // Chain id alone cannot prove this is a dev chain: real Base Sepolia
      // reports the same id (84532) by this project's own design (
      //). Probe an Anvil-only RPC method — present only on a real
      // Anvil node — before trusting a well-known dev key against it.
      const isAnvil = await probeIsAnvilNode(healthPublicClient);
      if (!isAnvil) {
        return {
          status: 'fail',
          detail:
            `RPC at ${options.rpcUrl} reports chain id ${LOCAL_CHAIN_ID} but does not answer ` +
            '"anvil_nodeInfo" — it does not look like a local Anvil dev node. Refusing to treat it ' +
            'as safe for a local-facilitator dev key.',
          checkedAt,
          durationMs: clock.monotonicMs() - startedAt,
        };
      }

      return {
        status: 'pass',
        detail:
          `RPC ${options.rpcUrl} reachable, chain id ${LOCAL_CHAIN_ID}, asset ${options.asset} has ` +
          'code, confirmed Anvil dev node',
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
