/**
 * MPP payment provider for the `charge` intent, the `evm` method and the
 * EIP-3009 `authorization` credential.
 *
 * It issues challenges and verifies credentials locally: verification recovers
 * a signature and compares terms, and never broadcasts or moves funds. It does
 * not settle. `settle` returns a rejection and `verify` returns no `replayKey`,
 * which the pipeline requires before settling, so no MPP payment is charged.
 */
import { Challenge, Credential, Errors, Method, PaymentRequest } from 'mppx';
import { Methods } from 'mppx/evm';
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
  type PaymentVerificationContext,
  systemClock,
} from '../../core/index.js';
import { parseCanonicalAmount } from '../x402/amount.js';
import { MPP_PROFILE, MPP_SPEC_DRAFTS } from './constants.js';
import { MPP_DESCRIPTOR } from './descriptor.js';

const CHAIN_ID = Number(MPP_PROFILE.network.split(':')[1]);
const DEFAULT_IDS: IdGenerator = {
  next: (prefix?: string) => `${prefix ? `${prefix}_` : ''}${crypto.randomUUID()}`,
};
const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
// An HMAC key shorter than its 32-byte output weakens every challenge it signs
const MIN_CHALLENGE_SECRET_LENGTH = 32;

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
  if (options.challengeSecret.length < MIN_CHALLENGE_SECRET_LENGTH) {
    throw configInvalid(
      `MPP challenge secret must be at least ${MIN_CHALLENGE_SECRET_LENGTH} characters`,
    );
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

  // mppx requires a settle callback to build the method, and calls it only
  // when broadcasting. This provider never broadcasts.
  const method = charge({
    currency: asset,
    recipient,
    chainId: CHAIN_ID,
    decimals: MPP_PROFILE.assetDecimals,
    authorization: { name: options.assetName, version: options.assetVersion },
    settle: async () => {
      throw new CommerceError('INTERNAL_ERROR', 'MPP settlement is not implemented');
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
      challenge: { provider: 'mpp', version: MPP_SPEC_DRAFTS.core, accepts: [challenge] },
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
    let payer: string;
    try {
      const validation = await Method.validateCredential([method], credential);
      payer = (validation.details as { payer: string }).payer;
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
    };
  }

  // A returned rejection states that nothing moved. A throw would be recorded
  // as a settlement that may have landed.
  async function settle(context: PaymentSettlementContext): Promise<PaymentResult> {
    return rejected(context.requirement, 'settlement_unavailable');
  }

  async function health(): Promise<AdapterHealth> {
    return { status: 'fail', detail: 'settlement-unavailable', checkedAt: clock.nowIso() };
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
