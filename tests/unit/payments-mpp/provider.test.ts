import { Challenge, Credential, Method } from 'mppx';
import { Methods, Types } from 'mppx/evm';
import { charge as clientCharge } from 'mppx/evm/client';
import type { LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Clock,
  type CommerceResource,
  isCommerceError,
  type PaymentProvider,
  type PaymentRequirement,
} from '../../../src/core/index.js';
import {
  createMppPaymentProvider,
  type MppProviderOptions,
} from '../../../src/payments/mpp/provider.js';
import { makeResource } from '../core/execution/helpers.js';

// Wraps the real broadcast so the no-funds-moved test can prove verify never
// reaches it
vi.mock('mppx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mppx')>();
  return {
    ...actual,
    Method: { ...actual.Method, broadcastCredential: vi.fn(actual.Method.broadcastCredential) },
  };
});

const ASSET = '0x1111111111111111111111111111111111111111' as const;
const OTHER_ASSET = '0x2222222222222222222222222222222222222222' as const;
const AUTHORIZATION = { name: 'MockUSDC', version: '2' };
const SECRET = 's'.repeat(32);
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const buyer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

// The provider returns the generic challenge type; the client wants the EVM one
type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

interface ChargeRequest {
  readonly amount: string;
  readonly currency: `0x${string}`;
  readonly recipient: `0x${string}`;
  readonly methodDetails: { readonly chainId: number };
}

function movableClock(start = Date.now()): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    nowIso: () => new Date(now).toISOString(),
    monotonicMs: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function makeProvider(overrides: Partial<MppProviderOptions> = {}): PaymentProvider {
  return createMppPaymentProvider({
    recipient,
    asset: ASSET,
    assetName: AUTHORIZATION.name,
    assetVersion: AUTHORIZATION.version,
    realm: 'gateway.test',
    challengeSecret: SECRET,
    ...overrides,
  });
}

function paidResource(id = 'market_report', amount = '0.01'): CommerceResource {
  return makeResource({
    id,
    pricing: { type: 'fixed', amount, currency: 'USDC' },
    paymentMethods: ['mpp'],
  });
}

function requirementFor(
  provider: PaymentProvider,
  resource = paidResource(),
  amount = '0.01',
  currency = 'USDC',
): Promise<PaymentRequirement> {
  return provider.createRequirement({
    requestId: 'req-1',
    resource,
    amount,
    currency,
    requestedAt: new Date().toISOString(),
  });
}

function issuedChallenge(requirement: PaymentRequirement): Challenge.Challenge {
  return requirement.challenge.accepts[0] as Challenge.Challenge;
}

// The external happy path: a credential exactly as the mppx buyer client makes it
async function clientCredential(requirement: PaymentRequirement): Promise<string> {
  const client = clientCharge({ account: buyer, authorization: AUTHORIZATION });
  return String(
    await client.createCredential({
      challenge: issuedChallenge(requirement) as EvmChallenge,
      context: {},
    }),
  );
}

// A correctly signed credential whose terms can be altered, for cases the mppx
// client never produces
async function signedCredential(
  challenge: Challenge.Challenge,
  patch: Partial<Record<'to' | 'value' | 'validAfter' | 'validBefore', string>> = {},
  options: { readonly signer?: LocalAccount; readonly source?: string } = {},
): Promise<string> {
  const request = challenge.request as unknown as ChargeRequest;
  const message = {
    from: buyer.address,
    to: request.recipient as string,
    value: request.amount,
    validAfter: '0',
    validBefore: String(Math.floor(new Date(challenge.expires ?? 0).getTime() / 1000)),
    nonce: Types.challengeHash(challenge),
    ...patch,
  };
  const signature = await (options.signer ?? buyer).signTypedData({
    domain: Types.authorizationDomain({
      authorization: AUTHORIZATION,
      chainId: request.methodDetails.chainId,
      currency: request.currency,
    }),
    types: Types.authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: message.from,
      to: message.to as `0x${string}`,
      value: BigInt(message.value),
      validAfter: BigInt(message.validAfter),
      validBefore: BigInt(message.validBefore),
      nonce: message.nonce,
    },
  });
  return Credential.serialize(
    Credential.from({
      challenge,
      payload: { type: 'authorization', ...message, signature },
      ...(options.source !== undefined ? { source: options.source } : {}),
    }),
  );
}

// Re-serialises a genuine credential with one part changed and nothing re-signed
function altered(
  serialized: string,
  change: (credential: {
    challenge: Challenge.Challenge;
    payload: Record<string, unknown>;
  }) => void,
): string {
  const credential = Credential.deserialize(serialized) as unknown as {
    challenge: Challenge.Challenge;
    payload: Record<string, unknown>;
  };
  const copy = structuredClone(credential);
  change(copy);
  return Credential.serialize(Credential.from(copy));
}

async function verifyWith(
  provider: PaymentProvider,
  requirement: PaymentRequirement,
  payload: string,
  resource = paidResource(),
) {
  return provider.verify({
    requestId: 'req-1',
    resource,
    requirement,
    submission: { method: 'mpp', payload },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createMppPaymentProvider', () => {
  it.each([
    ['a recipient that is not an address', { recipient: '0xnope' as `0x${string}` }],
    ['an asset that is not an address', { asset: '0x1234' as `0x${string}` }],
    ['a challenge secret shorter than the HMAC output', { challengeSecret: 'short' }],
    ['a multi-line realm', { realm: 'gateway.test\r\nX-Evil: 1' }],
    ['a TTL that is not a positive whole number', { challengeTtlSeconds: 0 }],
    ['an asset without its EIP-712 domain name', { assetName: '' }],
  ])('refuses %s at construction', (_label, overrides) => {
    expect(() => makeProvider(overrides)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});

describe('MPP createRequirement', () => {
  it('issues a challenge this gateway can later prove it issued, priced in base units', async () => {
    const clock = movableClock(Date.parse('2026-09-23T12:00:00.000Z'));
    const requirement = await requirementFor(makeProvider({ clock }));
    const challenge = issuedChallenge(requirement);
    const request = challenge.request as unknown as ChargeRequest & {
      methodDetails: { credentialTypes: string[] };
    };

    expect(Challenge.verify(challenge, { secretKey: SECRET })).toBe(true);
    expect(challenge).toMatchObject({ method: 'evm', intent: 'charge', realm: 'gateway.test' });
    expect(challenge.meta).toEqual({ resource: 'market_report' });
    expect(request.amount).toBe('10000');
    expect(request.recipient).toBe(recipient);
    expect(request.currency).toBe(ASSET);
    expect(request.methodDetails).toMatchObject({
      chainId: 84532,
      credentialTypes: ['authorization'],
    });
    expect(requirement).toMatchObject({
      provider: 'mpp',
      amount: '0.01',
      destination: recipient,
      network: 'eip155:84532',
      asset: ASSET,
      expiresAt: '2026-09-23T12:05:00.000Z',
    });
  });

  it.each([
    ['more precision than USDC has', '0.0000001', 'PAYMENT_INVALID'],
    ['zero', '0', 'PAYMENT_INVALID'],
    ['scientific notation', '1e-2', 'PAYMENT_INVALID'],
    ['a negative amount', '-0.01', 'PAYMENT_INVALID'],
  ])('refuses %s', async (_label, amount, code) => {
    await expect(requirementFor(makeProvider(), paidResource(), amount)).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === code,
    );
  });

  it('refuses a resource priced in anything but USDC', async () => {
    await expect(requirementFor(makeProvider(), paidResource(), '0.01', 'EUR')).rejects.toSatisfy(
      (error: unknown) => isCommerceError(error) && error.code === 'CONFIG_INVALID',
    );
  });
});

describe('MPP verify', () => {
  it('accepts a credential made by the mppx client, without moving funds', async () => {
    const provider = makeProvider();
    const requirement = await requirementFor(provider);
    const credential = await clientCredential(requirement);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await verifyWith(provider, requirement, credential);

    expect(result).toMatchObject({
      status: 'verified',
      provider: 'mpp',
      payer: buyer.address,
      payee: recipient,
      amount: '0.01',
      network: 'eip155:84532',
      asset: ASSET,
    });
    // Without a replay key the pipeline refuses to settle, so this rail
    // cannot charge
    expect(result.replayKey).toBeUndefined();
    expect(Method.broadcastCredential).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a proof that is not an MPP credential', async () => {
    const provider = makeProvider();
    const result = await verifyWith(provider, await requirementFor(provider), 'Payment !!!');
    expect(result).toMatchObject({ status: 'rejected', rejectionReason: 'malformed_credential' });
  });

  it('refuses a requirement another rail issued', async () => {
    const provider = makeProvider();
    const requirement = await requirementFor(provider);
    const foreign = { ...requirement, provider: 'x402' as const };
    const result = await verifyWith(provider, foreign, await clientCredential(requirement));
    expect(result.rejectionReason).toBe('wrong_provider');
  });

  describe('challenge binding', () => {
    it('refuses a challenge whose terms were edited after issue', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const tampered = altered(await clientCredential(requirement), (credential) => {
        (credential.challenge.request as Record<string, unknown>)['amount'] = '1';
      });
      const result = await verifyWith(provider, requirement, tampered);
      expect(result.rejectionReason).toBe('challenge_not_issued');
    });

    it('refuses a challenge signed with another gateway secret', async () => {
      const foreign = await requirementFor(makeProvider({ challengeSecret: 'o'.repeat(32) }));
      const provider = makeProvider();
      const result = await verifyWith(
        provider,
        await requirementFor(provider),
        await clientCredential(foreign),
      );
      expect(result.rejectionReason).toBe('challenge_not_issued');
    });

    it('refuses a challenge issued for another resource at the same price', async () => {
      const provider = makeProvider();
      const other = await requirementFor(provider, paidResource('other_report'));
      const result = await verifyWith(
        provider,
        await requirementFor(provider),
        await clientCredential(other),
      );
      expect(result.rejectionReason).toBe('wrong_resource');
    });

    it('refuses a challenge issued at another price', async () => {
      const provider = makeProvider();
      const cheaper = await requirementFor(provider, paidResource(), '0.005');
      const result = await verifyWith(
        provider,
        await requirementFor(provider),
        await clientCredential(cheaper),
      );
      expect(result.rejectionReason).toBe('wrong_amount');
    });

    it('refuses a challenge that pays another recipient', async () => {
      const elsewhere = await requirementFor(makeProvider({ recipient: stranger.address }));
      const provider = makeProvider();
      const result = await verifyWith(
        provider,
        await requirementFor(provider),
        await clientCredential(elsewhere),
      );
      expect(result.rejectionReason).toBe('wrong_recipient');
    });

    it('refuses a challenge in another asset', async () => {
      const otherAsset = await requirementFor(makeProvider({ asset: OTHER_ASSET }));
      const provider = makeProvider();
      const result = await verifyWith(
        provider,
        await requirementFor(provider),
        await clientCredential(otherAsset),
      );
      expect(result.rejectionReason).toBe('wrong_asset');
    });

    it('refuses a challenge on another network', async () => {
      const onBase = Challenge.fromMethod(Methods.charge, {
        secretKey: SECRET,
        realm: 'gateway.test',
        expires: new Date(Date.now() + 300_000),
        meta: { resource: 'market_report' },
        request: {
          amount: '0.01',
          currency: ASSET,
          recipient,
          chainId: 8453,
          decimals: 6,
          credentialTypes: ['authorization'],
        },
      });
      const provider = makeProvider();
      const result = await verifyWith(
        provider,
        await requirementFor(provider),
        await signedCredential(onBase),
      );
      expect(result.rejectionReason).toBe('wrong_network');
    });

    it('refuses a challenge once its expiry has passed', async () => {
      const clock = movableClock();
      const provider = makeProvider({ clock, challengeTtlSeconds: 60 });
      const requirement = await requirementFor(provider);
      const credential = await clientCredential(requirement);
      clock.advance(61_000);
      const result = await verifyWith(provider, requirement, credential);
      expect(result.rejectionReason).toBe('challenge_expired');
    });
  });

  describe('authorization', () => {
    it('refuses a credential type other than authorization', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const permit2 = altered(await clientCredential(requirement), (credential) => {
        credential.payload['type'] = 'permit2';
      });
      const result = await verifyWith(provider, requirement, permit2);
      expect(result.rejectionReason).toBe('unsupported_credential');
    });

    it('refuses a nonce that is not the challenge hash', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const wrongNonce = altered(await clientCredential(requirement), (credential) => {
        credential.payload['nonce'] = `0x${'0'.repeat(64)}`;
      });
      const result = await verifyWith(provider, requirement, wrongNonce);
      expect(result.rejectionReason).toBe('wrong_nonce');
    });

    it('refuses a signature from someone other than the payer', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const forged = await signedCredential(issuedChallenge(requirement), {}, { signer: stranger });
      const result = await verifyWith(provider, requirement, forged);
      expect(result.rejectionReason).toBe('invalid_signature');
    });

    it('refuses an authorization for a different amount than the challenge', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const underpaid = await signedCredential(issuedChallenge(requirement), { value: '9999' });
      const result = await verifyWith(provider, requirement, underpaid);
      expect(result.rejectionReason).toBe('wrong_amount');
    });

    it('refuses an authorization that pays someone other than the recipient', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const diverted = await signedCredential(issuedChallenge(requirement), {
        to: stranger.address,
      });
      const result = await verifyWith(provider, requirement, diverted);
      expect(result.rejectionReason).toBe('wrong_recipient');
    });

    it('refuses an authorization that is not valid yet', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const early = await signedCredential(issuedChallenge(requirement), {
        validAfter: String(Math.floor(Date.now() / 1000) + 3600),
      });
      const result = await verifyWith(provider, requirement, early);
      expect(result.rejectionReason).toBe('authorization_not_yet_valid');
    });

    it('refuses an authorization that has already expired', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const lapsed = await signedCredential(issuedChallenge(requirement), {
        validBefore: String(Math.floor(Date.now() / 1000) - 10),
      });
      const result = await verifyWith(provider, requirement, lapsed);
      expect(result.rejectionReason).toBe('authorization_expired');
    });

    it('refuses a declared source that is not the signer', async () => {
      const provider = makeProvider();
      const requirement = await requirementFor(provider);
      const misattributed = await signedCredential(
        issuedChallenge(requirement),
        {},
        { source: `did:pkh:eip155:84532:${stranger.address}` },
      );
      const result = await verifyWith(provider, requirement, misattributed);
      expect(result.rejectionReason).toBe('source_mismatch');
    });
  });
});

describe('MPP settle and health', () => {
  it('returns a rejection rather than throwing, because nothing was broadcast', async () => {
    const provider = makeProvider();
    const requirement = await requirementFor(provider);
    const credential = await clientCredential(requirement);
    const verification = await verifyWith(provider, requirement, credential);

    const result = await provider.settle({
      requestId: 'req-1',
      resource: paidResource(),
      requirement,
      submission: { method: 'mpp', payload: credential },
      verification,
    });

    expect(result).toMatchObject({ status: 'rejected', rejectionReason: 'settlement_unavailable' });
    expect(Method.broadcastCredential).not.toHaveBeenCalled();
  });

  it('reports fail, which blocks readiness while it cannot settle', async () => {
    expect((await makeProvider().health()).status).toBe('fail');
  });
});
