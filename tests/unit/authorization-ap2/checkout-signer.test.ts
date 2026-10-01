/**
 * The merchant-side signer, checked against the verifier that will judge it.
 *
 * The round trip is the test that matters: a JWT this helper produced has to
 * pass `verifyCheckoutJwt` and then bind to the purchase. Asserting the claim
 * names on their own would pass while the digest silently disagreed, which is
 * the failure the helper exists to prevent.
 */
import { createHash } from 'node:crypto';
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCheckoutJwt } from '../../../src/authorization/ap2';
import { AP2_CHECKOUT_PROFILE } from '../../../src/authorization/ap2/constants';
import { bindMandateToPurchase } from '../../../src/authorization/ap2/profile';
import {
  type Ap2MandateVerifier,
  createAp2MandateVerifier,
} from '../../../src/authorization/ap2/verifier';
import type { AuthorizationVerificationContext, PaymentRequirement } from '../../../src/core';
import { isCommerceError } from '../../../src/core';
import { createParties, fixedClock, mintMandate, NOW, type Party } from './fixtures';

const RESOURCE_ID = 'market_report';
// A float and non-ASCII text: inputs where some sorted-key serializers and
// RFC 8785 part company, and a hand-rolled signer starts producing mandates
// this gateway refuses
const INPUT = { city: 'Zürich', precision: 1.5e30, tags: ['b', 'a'] };
// INPUT in RFC 8785 form, written out by hand so the oracle is not the code under test
const INPUT_JCS = '{"city":"Zürich","precision":1.5e+30,"tags":["b","a"]}';

let parties: Party;
let verifier: Ap2MandateVerifier;
let privateJwk: Record<string, unknown>;

beforeAll(async () => {
  parties = await createParties();
  verifier = createAp2MandateVerifier({
    config: {
      enabled: true,
      specVersion: '0.2.0',
      mode: 'direct',
      trust: { mandateIssuers: parties.mandateIssuers, checkoutIssuers: parties.checkoutIssuers },
      clockSkewSeconds: 60,
      replay: { path: ':memory:' },
    },
    clock: fixedClock(),
  });
  privateJwk = (await exportJWK(parties.checkoutSigner.privateKey)) as Record<string, unknown>;
});

function signOptions(overrides: Record<string, unknown> = {}) {
  return {
    privateKey: privateJwk,
    kid: parties.checkoutSigner.kid,
    issuer: 'https://merchant.example',
    audience: 'agent-commerce',
    resourceId: RESOURCE_ID,
    input: INPUT,
    amount: '0.01',
    currency: 'USDC',
    paymentMethod: 'x402',
    destination: '0xMERCHANT',
    network: 'eip155:84532',
    asset: '0xASSET',
    now: NOW,
    ...overrides,
  } as Parameters<typeof createCheckoutJwt>[0];
}

function requirement(): PaymentRequirement {
  return {
    id: 'pr-1',
    requestId: 'req-1',
    resourceId: RESOURCE_ID,
    provider: 'x402',
    amount: '0.01',
    currency: 'USDC',
    destination: '0xMERCHANT',
    network: 'eip155:84532',
    asset: '0xASSET',
    challenge: { provider: 'x402', version: '2', accepts: [] },
  };
}

function context(): AuthorizationVerificationContext {
  return {
    requestId: 'req-1',
    resourceId: RESOURCE_ID,
    input: INPUT,
    submission: { method: 'ap2', payload: 'unused-here' },
    requirement: requirement(),
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'no-error';
}

describe('createCheckoutJwt', () => {
  it('produces a checkout JWT that verifies and authorizes the purchase', async () => {
    const jwt = await createCheckoutJwt(signOptions());
    const presentation = await mintMandate(parties.mandateSigner, jwt);

    const mandate = await verifier.verify(presentation);
    await expect(bindMandateToPurchase(mandate, context(), {})).resolves.toBeUndefined();
  });

  it('signs the RFC 8785 digest of the input', async () => {
    const jwt = await createCheckoutJwt(signOptions());
    const mandate = await verifier.verify(await mintMandate(parties.mandateSigner, jwt));

    const profile = mandate.checkoutClaims['agent_commerce'] as Record<string, string>;
    expect(profile['input_hash']).toBe(
      createHash('sha256').update(INPUT_JCS, 'utf8').digest('base64url'),
    );
    expect(profile['profile']).toBe(AP2_CHECKOUT_PROFILE);
  });

  it('accepts a PKCS#8 PEM as well as a private JWK', async () => {
    const pem = await exportPKCS8(parties.checkoutSigner.privateKey);
    const jwt = await createCheckoutJwt(signOptions({ privateKey: pem }));

    const mandate = await verifier.verify(await mintMandate(parties.mandateSigner, jwt));
    expect(mandate.checkoutIssuer).toBe('https://merchant.example');
  });

  it('omits the chain claims when the purchase has no chain coordinates', async () => {
    const jwt = await createCheckoutJwt(
      signOptions({ destination: undefined, network: undefined, asset: undefined }),
    );
    const mandate = await verifier.verify(await mintMandate(parties.mandateSigner, jwt));

    const profile = mandate.checkoutClaims['agent_commerce'] as Record<string, string>;
    // Absent, not present-and-undefined: the gateway checks a claim whenever
    // either side names one
    expect('destination' in profile).toBe(false);
    expect('network' in profile).toBe(false);
    expect('asset' in profile).toBe(false);
  });

  it('mints a jti when none is supplied, and honors one that is', async () => {
    const generated = await createCheckoutJwt(signOptions());
    const supplied = await createCheckoutJwt(signOptions({ jwtId: 'checkout_01KNOWN' }));

    const first = await verifier.verify(await mintMandate(parties.mandateSigner, generated));
    const second = await verifier.verify(await mintMandate(parties.mandateSigner, supplied));

    expect(first.checkoutJwtId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.checkoutJwtId).toBe('checkout_01KNOWN');
  });

  it('expires 15 minutes out by default, and honors an explicit window', async () => {
    const now = Math.floor(NOW.getTime() / 1000);
    const claimsOf = async (jwt: string): Promise<Record<string, number>> =>
      JSON.parse(Buffer.from(jwt.split('.')[1] as string, 'base64url').toString('utf8')) as Record<
        string,
        number
      >;

    expect((await claimsOf(await createCheckoutJwt(signOptions())))['exp']).toBe(now + 900);
    expect(
      (await claimsOf(await createCheckoutJwt(signOptions({ expiresInSeconds: 60 }))))['exp'],
    ).toBe(now + 60);
  });

  describe('refuses what would fail verification with no useful reason', () => {
    it('refuses a numeric amount', async () => {
      const message = await failureOf(() => createCheckoutJwt(signOptions({ amount: 0.01 })));
      expect(message).toContain('decimal string');
    });

    it('refuses the public half of the key pair', async () => {
      const { d: _d, ...publicHalf } = privateJwk;
      const message = await failureOf(() =>
        createCheckoutJwt(signOptions({ privateKey: publicHalf })),
      );
      expect(message).toContain('public JWK');
    });

    it('refuses a key that is not P-256', async () => {
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      const rsa = (await exportJWK(privateKey)) as Record<string, unknown>;
      const message = await failureOf(() => createCheckoutJwt(signOptions({ privateKey: rsa })));
      expect(message).toContain('EC/P-256');
    });

    it('refuses a string key that is not a PKCS#8 PEM', async () => {
      const message = await failureOf(() =>
        createCheckoutJwt(signOptions({ privateKey: '-----BEGIN EC PRIVATE KEY-----' })),
      );
      expect(message).toContain('PKCS#8');
    });

    it('names the missing field rather than signing an unverifiable JWT', async () => {
      expect(await failureOf(() => createCheckoutJwt(signOptions({ kid: '' })))).toContain('kid');
      expect(
        await failureOf(() => createCheckoutJwt(signOptions({ resourceId: undefined }))),
      ).toContain('resourceId');
    });

    it('refuses a non-canonicalizable input rather than hashing something else', async () => {
      // A BigInt throws inside canonicalize; a function serializes to nothing
      // and is caught by computeInputHash. Both must fail, neither may sign.
      expect(await failureOf(() => createCheckoutJwt(signOptions({ input: { n: 1n } })))).toContain(
        'BigInt',
      );
      expect(await failureOf(() => createCheckoutJwt(signOptions({ input: () => 1 })))).toContain(
        'canonicalizable',
      );
    });
  });

  it('produces a mandate the gateway refuses when the price disagrees', async () => {
    // The helper cannot know the gateway's requirement, so a wrong price is
    // still caught at verification - fail closed, just without a useful reason
    const jwt = await createCheckoutJwt(signOptions({ amount: '500.00' }));
    const mandate = await verifier.verify(await mintMandate(parties.mandateSigner, jwt));

    await expect(bindMandateToPurchase(mandate, context(), {})).rejects.toSatisfy(
      (error: unknown) =>
        isCommerceError(error) &&
        error.code === 'AUTHORIZATION_INVALID' &&
        error.details?.['reason'] === 'purchase_mismatch',
    );
  });
});
