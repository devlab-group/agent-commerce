/**
 * MPP payment provider for the `charge` intent, the `evm` method and the
 * EIP-3009 `authorization` credential.
 *
 * It issues challenges and verifies credentials locally without moving funds.
 * Settlement rewraps the signed authorization for the x402 provider passed as
 * `settlement`. The MPP layer adds no signing key; the supplied provider owns
 * facilitator configuration and settlement credentials.
 */
import { Challenge, Credential, Errors, Method, PaymentRequest, Receipt } from 'mppx';
import { Methods, type Types } from 'mppx/evm';
import { charge } from 'mppx/evm/server';
import { getAddress, isAddress } from 'viem';
import {
  type AdapterHealth,
  type Clock,
  CommerceError,
  type IdGenerator,
  type PaymentContext,
  type PaymentProvider,
  type PaymentRequirement,
  type PaymentResult,
  type PaymentSettlementContext,
  type PaymentSubmission,
  type PaymentVerificationContext,
  systemClock,
} from '../../core/index.js';
import { parseCanonicalAmount } from '../x402/amount.js';
import { computeReplayKey } from '../x402/replay-key.js';
import { MPP_MIN_CHALLENGE_SECRET_LENGTH, MPP_PROFILE, MPP_SPEC_DRAFTS } from './constants.js';
import { MPP_DESCRIPTOR } from './descriptor.js';

const CHAIN_ID = Number(MPP_PROFILE.network.split(':')[1]);
const DEFAULT_IDS: IdGenerator = {
  next: (prefix?: string) => `${prefix ? `${prefix}_` : ''}${crypto.randomUUID()}`,
};
const DEFAULT_CHALLENGE_TTL_SECONDS = 300;

export interface MppProviderOptions {
  /** Merchant-controlled settlement destination. Never gateway-owned */
  readonly recipient: `0x${string}`;
  /** EIP-3009 token the charge is paid in */
  readonly asset: `0x${string}`;
  /** EIP-712 domain name of the asset, e.g. 'USDC' or 'MockUSDC' */
  readonly assetName: string;
  /** EIP-712 domain version of the asset, e.g. '2' */
  readonly assetVersion: string;
  /** Value of each challenge's `realm`, such as the gateway's host */
  readonly realm: string;
  /** Key that binds each challenge to this gateway. Never logged or published */
  readonly challengeSecret: string;
  /**
   * x402 provider used for settlement. Each requirement it returns must match
   * this provider's network, asset, EIP-712 domain and recipient.
   */
  readonly settlement: PaymentProvider;
  /**
   * Seconds a challenge stays valid, 300 by default. The mppx client signs its
   * authorization to expire at the same moment.
   */
  readonly challengeTtlSeconds?: number;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

// mppx reports a verification failure only as message text. The pinned
// release's wording maps to stable reasons, and the tests cover every entry;
// unmapped text becomes `authorization_invalid`.
const VERIFICATION_REASONS: readonly (readonly [string, string])[] = [
  ['EVM authorization challenge hash mismatch', 'wrong_nonce'],
  ['EVM authorization signature mismatch', 'invalid_signature'],
  ['EVM authorization is not valid yet', 'authorization_not_yet_valid'],
  ['EVM authorization has expired', 'authorization_expired'],
  ['EVM authorization source mismatch', 'source_mismatch'],
  ['EVM authorization amount mismatch', 'wrong_amount'],
  ['EVM authorization recipient mismatch', 'wrong_recipient'],
];

function configInvalid(message: string): CommerceError {
  return new CommerceError('CONFIG_INVALID', message);
}

function validateOptions(options: MppProviderOptions): void {
  if (!isAddress(options.recipient)) throw configInvalid('MPP recipient is not an EVM address');
  if (!isAddress(options.asset)) throw configInvalid('MPP asset is not an EVM address');
  if (options.assetName.length === 0 || options.assetVersion.length === 0) {
    throw configInvalid('MPP asset needs its EIP-712 domain name and version');
  }
  // mppx refuses CR or LF in the quoted realm parameter, so checking here fails
  // at construction instead of on every challenge
  if (options.realm.length === 0 || /[\r\n]/.test(options.realm)) {
    throw configInvalid('MPP realm must be a non-empty single-line string');
  }
  if (options.challengeSecret.length < MPP_MIN_CHALLENGE_SECRET_LENGTH) {
    throw configInvalid(
      `MPP challenge secret must have length at least ${MPP_MIN_CHALLENGE_SECRET_LENGTH}`,
    );
  }
  if (options.settlement?.name !== 'x402') {
    throw configInvalid('MPP settlement must be an x402 payment provider');
  }
  const ttl = options.challengeTtlSeconds;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) {
    throw configInvalid('MPP challenge TTL must be a positive whole number of seconds');
  }
}

function verificationReason(error: unknown): string {
  if (error instanceof Errors.PaymentExpiredError) return 'challenge_expired';
  if (error instanceof Errors.InvalidPayloadError) return 'invalid_payload';
  if (error instanceof Errors.InvalidChallengeError) return 'invalid_challenge';
  if (error instanceof Errors.VerificationFailedError) {
    const match = VERIFICATION_REASONS.find(([text]) => error.message.includes(text));
    if (match) return match[1];
  }
  return 'authorization_invalid';
}

export function createMppPaymentProvider(options: MppProviderOptions): PaymentProvider {
  validateOptions(options);
  const clock = options.clock ?? systemClock;
  const ttlSeconds = options.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  const recipient = getAddress(options.recipient);
  const asset = getAddress(options.asset);
  const ids = options.ids ?? DEFAULT_IDS;

  // charge() requires a callback even though this provider never invokes the
  // mppx broadcast path. Settlement is delegated through options.settlement.
  const method = charge({
    currency: asset,
    recipient,
    chainId: CHAIN_ID,
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
      network: MPP_PROFILE.network,
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
    await settlementRequirement(context);
    const expires = new Date(clock.now().getTime() + ttlSeconds * 1000);
    const challenge = Challenge.fromMethod(Methods.charge, {
      secretKey: options.challengeSecret,
      realm: options.realm,
      expires,
      // Bound by the challenge HMAC, so a challenge for one resource cannot pay
      // for another at the same price
      meta: { resource: context.resource.id },
      request: {
        amount: context.amount,
        currency: asset,
        recipient,
        chainId: CHAIN_ID,
        decimals: MPP_PROFILE.assetDecimals,
        credentialTypes: [MPP_PROFILE.credentialType],
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
      network: MPP_PROFILE.network,
      asset,
      expiresAt: expires.toISOString(),
      challenge: {
        provider: 'mpp',
        version: MPP_SPEC_DRAFTS.core,
        accepts: [challenge],
        // Serialised here because the HTTP route, which sends it as
        // `WWW-Authenticate`, is in the main entry and cannot import mppx
        envelope: { wwwAuthenticate: Challenge.serialize(challenge) },
      },
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
      credential = Credential.deserialize(submission.payload);
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

    return {
      status: 'verified',
      provider: 'mpp',
      payer,
      payee: recipient,
      amount: requirement.amount,
      currency: requirement.currency,
      network: MPP_PROFILE.network,
      asset,
      // Match x402's key so the same authorization collides across both rails
      replayKey: computeReplayKey({
        chainId: CHAIN_ID,
        asset,
        from: payer,
        // validateCredential proved it equals the 32-byte challenge hash
        nonce: (credential.payload as Types.AuthorizationPayload).nonce as `0x${string}`,
      }),
    };
  }

  async function settlementRequirement(context: PaymentContext): Promise<PaymentRequirement> {
    const x402 = await options.settlement.createRequirement(context);
    const extra = (x402.challenge.accepts[0]?.['extra'] ?? {}) as Record<string, unknown>;
    if (
      x402.network !== MPP_PROFILE.network ||
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

    // Nothing before the final settle call can broadcast, so failures here are
    // rejections that let the pipeline release its reservation
    let x402Context: PaymentSettlementContext;
    try {
      const x402Requirement = await settlementRequirement({
        requestId,
        resource,
        amount: requirement.amount,
        currency: requirement.currency,
        requestedAt: clock.nowIso(),
      });
      const x402Submission = toX402Submission(x402Requirement, submission);
      const x402Verification = await options.settlement.verify({
        requestId,
        resource,
        requirement: x402Requirement,
        submission: x402Submission,
      });
      if (x402Verification.status !== 'verified') {
        return rejected(requirement, x402Verification.rejectionReason ?? 'settlement_rejected');
      }
      // A different key would settle an authorization the pipeline did not reserve
      if (x402Verification.replayKey !== verification.replayKey) {
        return rejected(requirement, 'settlement_mismatch');
      }
      x402Context = {
        requestId,
        resource,
        requirement: x402Requirement,
        submission: x402Submission,
        verification: x402Verification,
      };
    } catch {
      return rejected(requirement, 'settlement_unavailable');
    }

    // A throw from x402 settle may follow a broadcast, so let the pipeline mark it uncertain
    const settled = await options.settlement.settle(x402Context);
    const result: PaymentResult = {
      ...settled,
      provider: 'mpp',
      amount: requirement.amount,
      currency: requirement.currency,
      replayKey: verification.replayKey,
    };
    if (settled.status !== 'settled' || settled.externalReference === undefined) return result;
    // Serialised for the HTTP route's `Payment-Receipt` header
    const receipt = Receipt.from({
      method: MPP_PROFILE.method,
      reference: settled.externalReference,
      status: 'success',
      timestamp: settled.settledAt ?? clock.nowIso(),
    });
    return { ...result, metadata: { ...settled.metadata, receipt: Receipt.serialize(receipt) } };
  }

  function health(): Promise<AdapterHealth> {
    return options.settlement.health();
  }

  return { name: 'mpp', descriptor: MPP_DESCRIPTOR, createRequirement, verify, settle, health };
}

// Compares the echoed challenge with the one issued for this request. Both
// carry a valid HMAC by now, so any difference means the credential answers a
// challenge issued for other terms. The final comparison catches a difference
// in any request field the named checks do not cover.
function bindingMismatch(
  echoed: Challenge.Challenge,
  issued: Challenge.Challenge,
  resourceId: string,
): string | undefined {
  if (echoed.realm !== issued.realm) return 'wrong_realm';
  if (echoed.method !== issued.method || echoed.intent !== issued.intent) {
    return 'unsupported_method';
  }
  // Only the encoded `opaque` survives the credential round trip, not `meta`,
  // so compare it with the encoding of this resource's binding
  if (echoed.opaque !== PaymentRequest.serialize({ resource: resourceId })) {
    return 'wrong_resource';
  }
  const got = echoed.request as ChargeRequest;
  const want = issued.request as ChargeRequest;
  if (got.amount !== want.amount) return 'wrong_amount';
  if (!sameAddress(got.recipient, want.recipient)) return 'wrong_recipient';
  if (got.methodDetails?.chainId !== want.methodDetails?.chainId) return 'wrong_network';
  if (!sameAddress(got.currency, want.currency)) return 'wrong_asset';
  if (canonical(got.methodDetails) !== canonical(want.methodDetails)) {
    return 'unsupported_credential';
  }
  if (canonical(got) !== canonical(want)) return 'wrong_terms';
  return undefined;
}

// Rewrap the MPP authorization as the x402 `exact` payload expected by settlement
function toX402Submission(
  x402Requirement: PaymentRequirement,
  submission: PaymentSubmission,
): PaymentSubmission {
  const { signature, from, to, value, validAfter, validBefore, nonce } = Credential.deserialize(
    submission.payload,
  ).payload as Types.AuthorizationPayload;
  const payment = {
    x402Version: 2,
    accepted: x402Requirement.challenge.accepts[0],
    payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } },
  };
  return { method: 'x402', payload: Buffer.from(JSON.stringify(payment)).toString('base64') };
}

interface ChargeRequest {
  readonly amount?: string;
  readonly currency?: string;
  readonly recipient?: string;
  readonly methodDetails?: { readonly chainId?: number };
}

// The encoding mppx binds into the challenge HMAC, so key order cannot
// produce a false mismatch
function canonical(value: object | undefined): string {
  return value === undefined ? '' : PaymentRequest.serialize(value as PaymentRequest.Request);
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && isAddress(a) && isAddress(b)
    ? getAddress(a) === getAddress(b)
    : false;
}
