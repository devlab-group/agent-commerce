/**
 * MPP payment provider for the `charge` intent, the `evm` method and the
 * EIP-3009 `authorization` credential.
 *
 * It issues challenges and verifies credentials without moving funds: local
 * checks first, then a read-only check by an x402 facilitator. Settlement hands
 * the same signed authorization to that facilitator through an internal x402
 * provider built from these options. The MPP layer adds no signing key.
 *
 * Under the default `upfront` flow settlement precedes the backend call; under
 * `authorization` it follows a successful one. The drafts require a confirmed
 * transaction before a `Payment-Receipt`.
 */
import { PERMIT2_ADDRESS } from '@x402/evm';
import { Challenge, type Credential, Method, Receipt } from 'mppx';
import { Methods, type Types } from 'mppx/evm';
import { charge } from 'mppx/evm/server';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import {
  type AdapterHealth,
  CommerceError,
  type PaymentContext,
  type PaymentProvider,
  type PaymentRequirement,
  type PaymentResult,
  type PaymentSettlementContext,
  type PaymentVerificationContext,
  RECONCILIATION_METADATA_KEY,
  systemClock,
} from '../../core';
import { SETTLE_AFTER_BACKEND_METADATA_KEY } from '../../core/execution/settlement-order';
import { parseCanonicalAmount } from '../x402/amount';
import { eip3009Locator } from '../x402/locator';
import { createX402PaymentProvider, DEFAULT_IDS } from '../x402/provider';
import { computeReplayKey } from '../x402/replay-key';
import {
  MPP_DEFAULT_NETWORK,
  MPP_DEFAULT_PAYMENT_FLOW,
  MPP_PROFILE,
  MPP_SPEC_DRAFTS,
} from './constants';
import {
  bindingMismatch,
  decodeCredential,
  sameAddress,
  toX402Submission,
  verificationReason,
} from './credential';
import { MPP_DESCRIPTOR } from './descriptor';
import {
  configInvalid,
  type MppChallengeOptions,
  type MppProviderOptions,
  type NonceUsedReader,
  validateOptions,
} from './options';
import { CONTENT_DIGEST_METADATA_KEY } from './transport';

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;

// The x402 SDK's verify reason for an EIP-3009 nonce already spent on chain
const NONCE_ALREADY_USED = 'invalid_exact_evm_nonce_already_used';

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

const NONCE_READ_TIMEOUT_MS = 5_000;

export function createMppPaymentProvider(options: MppProviderOptions): PaymentProvider {
  const { rpcUrl, facilitator, allowMainnet, allowUnauthenticatedFacilitator, logger, ...rest } =
    options;
  // Checked first so a bad MPP option is reported as one, not as an x402 error
  validateOptions(rest);
  // Built from the same terms, and never registered as a rail, so an MPP-only
  // deployment needs no x402 configuration
  const settlement = createX402PaymentProvider({
    network: options.network ?? MPP_DEFAULT_NETWORK,
    rpcUrl,
    asset: options.asset,
    assetName: options.assetName,
    assetVersion: options.assetVersion,
    assetDecimals: MPP_PROFILE.assetDecimals,
    payTo: options.recipient,
    facilitator,
    ...(allowMainnet !== undefined ? { allowMainnet } : {}),
    ...(allowUnauthenticatedFacilitator !== undefined ? { allowUnauthenticatedFacilitator } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  // One attempt: the read only names the reason for a refusal already decided
  const chain = createPublicClient({
    transport: http(rpcUrl, { timeout: NONCE_READ_TIMEOUT_MS, retryCount: 0 }),
  });
  const nonceUsed: NonceUsedReader = (payer, nonce) =>
    chain.readContract({
      address: options.asset,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [payer, nonce],
    });
  return createMppProviderWithSettlement(rest, settlement, nonceUsed);
}

/**
 * Internal seam: tests inject a settlement provider and the nonce reader. Not
 * exported from the `./mpp` entry.
 */
export function createMppProviderWithSettlement(
  options: MppChallengeOptions,
  settlement: PaymentProvider,
  nonceUsed?: NonceUsedReader,
): PaymentProvider {
  validateOptions(options);
  if (settlement.name !== 'x402') {
    throw configInvalid('MPP settlement must be an x402 payment provider');
  }
  const network = options.network ?? MPP_DEFAULT_NETWORK;
  const chainId = Number(network.split(':')[1]);
  const clock = options.clock ?? systemClock;
  const ttlSeconds = options.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  const recipient = getAddress(options.recipient);
  const asset = getAddress(options.asset);
  const ids = options.ids ?? DEFAULT_IDS;
  // The settlement provider's terms are fixed at construction, so one passing
  // check covers every later challenge
  let settlementTermsChecked = false;

  // charge() requires a callback even though this provider never invokes the
  // mppx broadcast path. Settlement is delegated to the x402 provider.
  const method = charge({
    currency: asset,
    recipient,
    chainId,
    decimals: MPP_PROFILE.assetDecimals,
    authorization: { name: options.assetName, version: options.assetVersion },
    settle: async () => {
      throw new CommerceError('INTERNAL_ERROR', 'MPP direct broadcast is disabled');
    },
  });

  function rejected(requirement: PaymentRequirement, reason: string): PaymentResult {
    return {
      status: 'rejected',
      provider: 'mpp',
      amount: requirement.amount,
      currency: requirement.currency,
      network,
      asset,
      rejectionReason: reason,
    };
  }

  async function createRequirement(context: PaymentContext): Promise<PaymentRequirement> {
    if (context.currency !== MPP_PROFILE.assetSymbol) {
      throw configInvalid(
        `Resource "${context.resource.id}" is priced in ${context.currency}, but MPP charges ${MPP_PROFILE.assetSymbol}`,
      );
    }
    // Strict parse first: mppx converts with viem's parseUnits, which rounds
    // excess precision instead of refusing it
    if (parseCanonicalAmount(context.amount, MPP_PROFILE.assetDecimals) <= 0n) {
      throw new CommerceError('PAYMENT_INVALID', `Amount "${context.amount}" must be above zero`, {
        details: { amount: context.amount },
      });
    }
    // Reject a mismatched settlement requirement before the buyer signs
    if (!settlementTermsChecked) {
      await settlementRequirement(context);
      settlementTermsChecked = true;
    }
    const paymentFlow =
      options.resourcePaymentFlows?.[context.resource.id] ??
      options.paymentFlow ??
      MPP_DEFAULT_PAYMENT_FLOW;
    // mppx signs `validBefore` at this expiry. Under `authorization`, the
    // backend must finish before then for settlement to proceed.
    const expires = new Date(clock.now().getTime() + ttlSeconds * 1000);
    const digest = context.metadata?.[CONTENT_DIGEST_METADATA_KEY];
    const challenge = Challenge.fromMethod(Methods.charge, {
      secretKey: options.challengeSecret,
      realm: options.realm,
      expires,
      // Present for an HTTP request with a body. MCP and A2A carry the proof
      // in the body itself, so their challenges bind none.
      ...(typeof digest === 'string' ? { digest } : {}),
      // Bound by the challenge HMAC, so a challenge for one resource cannot pay
      // for another at the same price
      meta: { resource: context.resource.id },
      request: {
        amount: context.amount,
        currency: asset,
        recipient,
        chainId,
        decimals: MPP_PROFILE.assetDecimals,
        credentialTypes: [MPP_PROFILE.credentialType],
        // Required by draft-evm-charge-00 for every credential type
        permit2Address: PERMIT2_ADDRESS,
      },
    });
    return {
      id: ids.next('payreq'),
      requestId: context.requestId,
      resourceId: context.resource.id,
      provider: 'mpp',
      amount: context.amount,
      currency: context.currency,
      destination: recipient,
      network,
      asset,
      expiresAt: expires.toISOString(),
      challenge: {
        provider: 'mpp',
        version: MPP_SPEC_DRAFTS.core,
        accepts: [challenge],
        // Build both carrier forms here because the HTTP route and MCP
        // adapter cannot import mppx: a header value for HTTP and challenge
        // objects for MCP
        envelope: { wwwAuthenticate: Challenge.serialize(challenge), challenges: [challenge] },
      },
      metadata: { [SETTLE_AFTER_BACKEND_METADATA_KEY]: paymentFlow === 'authorization' },
    };
  }

  async function verify(context: PaymentVerificationContext): Promise<PaymentResult> {
    const { requirement, resource, submission } = context;
    if (requirement.provider !== 'mpp' || requirement.challenge.provider !== 'mpp') {
      return rejected(requirement, 'wrong_provider');
    }
    const issued = requirement.challenge.accepts[0] as Challenge.Challenge | undefined;
    if (!issued) return rejected(requirement, 'missing_challenge');

    let credential: Credential.Credential;
    try {
      credential = decodeCredential(submission.payload);
    } catch {
      return rejected(requirement, 'malformed_credential');
    }
    const echoed = credential.challenge;

    // A valid HMAC means this gateway issued the challenge, not that it was
    // issued for this resource and price. The binding checks below close that gap.
    if (!Challenge.verify(echoed, { secretKey: options.challengeSecret })) {
      return rejected(requirement, 'challenge_not_issued');
    }
    const binding = bindingMismatch(echoed, issued, resource.id);
    if (binding) return rejected(requirement, binding);
    if (!echoed.expires || new Date(echoed.expires).getTime() <= clock.now().getTime()) {
      return rejected(requirement, 'challenge_expired');
    }
    if ((credential.payload as { type?: unknown } | null)?.type !== MPP_PROFILE.credentialType) {
      return rejected(requirement, 'unsupported_credential');
    }

    // Local checks only: signature recovery, nonce == challenge hash, the
    // validity window and payload terms. With no network call involved, any
    // failure here is a verdict on the credential, not an outage.
    let payer: `0x${string}`;
    try {
      const validation = await Method.validateCredential([method], credential);
      payer = getAddress((validation.details as { payer: string }).payer);
    } catch (error) {
      return rejected(requirement, verificationReason(error));
    }

    const authorization = credential.payload as Types.AuthorizationPayload;
    // validateCredential proved it equals the 32-byte challenge hash
    const nonce = authorization.nonce as `0x${string}`;
    // Match x402's key so the same authorization collides across both rails
    const replayKey = computeReplayKey({ chainId, asset, from: payer, nonce });

    // The facilitator check runs before the pipeline reserves the replay key,
    // so an outage throws the x402 provider's retryable error and uses up
    // nothing, and a refusal is an ordinary rejection
    const x402Verification = await settlement.verify(await toX402Context(context, authorization));
    if (x402Verification.status !== 'verified') {
      // A spent challenge-hash nonce means the challenge was used. Check
      // the token when the facilitator reports only a simulation failure;
      // keep its reason if the token read fails.
      const reason = x402Verification.rejectionReason;
      const spent =
        reason === NONCE_ALREADY_USED ||
        ((await nonceUsed?.(payer, nonce).catch(() => false)) ?? false);
      return rejected(
        requirement,
        spent ? 'challenge_already_used' : (reason ?? 'settlement_rejected'),
      );
    }
    // A different key would settle an authorization the pipeline did not reserve
    if (x402Verification.replayKey !== replayKey) {
      return rejected(requirement, 'settlement_mismatch');
    }

    return {
      status: 'verified',
      provider: 'mpp',
      payer,
      payee: recipient,
      amount: requirement.amount,
      currency: requirement.currency,
      network,
      asset,
      replayKey,
      // Share x402's locator builder so both rails identify the same authorization
      metadata: { [RECONCILIATION_METADATA_KEY]: eip3009Locator(network, asset, authorization) },
    };
  }

  // The same payment as an x402 requirement and `exact` submission
  async function toX402Context(
    context: PaymentVerificationContext,
    authorization: Types.AuthorizationPayload,
  ): Promise<PaymentVerificationContext> {
    const { requestId, requirement, resource } = context;
    const x402Requirement = await settlementRequirement({
      requestId,
      resource,
      amount: requirement.amount,
      currency: requirement.currency,
      requestedAt: clock.nowIso(),
    });
    return {
      requestId,
      resource,
      requirement: x402Requirement,
      submission: toX402Submission(x402Requirement, authorization),
    };
  }

  async function settlementRequirement(context: PaymentContext): Promise<PaymentRequirement> {
    const x402 = await settlement.createRequirement(context);
    const extra = (x402.challenge.accepts[0]?.['extra'] ?? {}) as Record<string, unknown>;
    if (
      x402.network !== network ||
      !sameAddress(x402.asset, asset) ||
      !sameAddress(x402.destination, recipient) ||
      extra['name'] !== options.assetName ||
      extra['version'] !== options.assetVersion
    ) {
      throw configInvalid(
        'MPP settlement provider must use the same network, asset, EIP-712 domain and recipient',
      );
    }
    return x402;
  }

  async function settle(context: PaymentSettlementContext): Promise<PaymentResult> {
    const { requestId, requirement, resource, submission, verification } = context;
    if (verification.status !== 'verified' || verification.replayKey === undefined) {
      throw new CommerceError(
        'PAYMENT_INVALID',
        'MPP settle() called without a successful verify()',
      );
    }

    // verify() already ran the facilitator check, and the facilitator checks
    // again before broadcasting. A throw may follow a broadcast, so it
    // propagates and the pipeline marks the payment uncertain.
    const credential = decodeCredential(submission.payload);
    const authorization = credential.payload as Types.AuthorizationPayload;
    const settled = await settlement.settle({
      ...(await toX402Context({ requestId, requirement, resource, submission }, authorization)),
      verification: { ...verification, provider: 'x402' },
    });
    const result: PaymentResult = {
      ...settled,
      provider: 'mpp',
      amount: requirement.amount,
      currency: requirement.currency,
      replayKey: verification.replayKey,
    };
    if (settled.status !== 'settled' || settled.externalReference === undefined) return result;
    // Include the EVM method's `challengeId` and `chainId` in the receipt
    // sent through the HTTP `Payment-Receipt` header
    const fields: Receipt.Receipt & { challengeId: string; chainId: number } = {
      method: MPP_PROFILE.method,
      reference: settled.externalReference,
      status: 'success',
      timestamp: settled.settledAt ?? clock.nowIso(),
      challengeId: credential.challenge.id,
      chainId,
    };
    const receipt = Receipt.from(fields);
    return { ...result, metadata: { ...settled.metadata, receipt: Receipt.serialize(receipt) } };
  }

  function health(): Promise<AdapterHealth> {
    return settlement.health();
  }

  // Reuse the settlement provider's reconciliation for the credential's
  // EIP-3009 authorization
  const reconcile = settlement.reconcile?.bind(settlement);
  return {
    name: 'mpp',
    descriptor: MPP_DESCRIPTOR,
    createRequirement,
    verify,
    settle,
    ...(reconcile !== undefined ? { reconcile } : {}),
    health,
  };
}

export type { MppProviderOptions, NonceUsedReader } from './options';
