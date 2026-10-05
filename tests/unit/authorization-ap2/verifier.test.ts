/**
 * The Direct Checkout Mandate verifier, with real ES256 signatures. See
 * fixtures.ts for what these vectors are and are not.
 *
 * Every negative case asserts the error CODE too: reporting a bad mandate as a
 * payment problem would tell an auto-paying client to spend money on a request
 * that was never going to be delivered.
 */
import { createHmac, createPublicKey } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyMandate } from '../../../src/authorization/ap2/sd-jwt';
import { createTrustStore } from '../../../src/authorization/ap2/trust';
import type { EnabledAp2Config } from '../../../src/authorization/ap2/types';
import {
  type Ap2MandateVerifier,
  createAp2MandateVerifier,
} from '../../../src/authorization/ap2/verifier';
import { type CommerceError, isCommerceError } from '../../../src/core';
import {
  CHECKOUT_AUDIENCE,
  CHECKOUT_ISSUER,
  checkoutPayload,
  createParties,
  disclosure,
  fixedClock,
  MANDATE_AUDIENCE,
  MANDATE_ISSUER,
  mintMandate,
  NOW,
  type Party,
  sha256Base64url,
  signCheckoutJwt,
  trustedIssuer,
} from './fixtures';

let parties: Party;
let verifier: Ap2MandateVerifier;
let validPresentation: string;
let checkoutJwt: string;

function configFor(party: Party, overrides: Partial<EnabledAp2Config> = {}): EnabledAp2Config {
  return {
    enabled: true,
    specVersion: '0.2.0',
    mode: 'direct',
    trust: { mandateIssuers: party.mandateIssuers, checkoutIssuers: party.checkoutIssuers },
    clockSkewSeconds: 60,
    replay: { path: ':memory:' },
    ...overrides,
  };
}

function verifierFor(config: EnabledAp2Config, at: Date = NOW): Ap2MandateVerifier {
  return createAp2MandateVerifier({ config, clock: fixedClock(at) });
}

// Returns the CommerceError a rejected verification produced
async function rejection(run: Promise<unknown>): Promise<CommerceError> {
  try {
    await run;
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    return error as CommerceError;
  }
  return expect.unreachable('expected the mandate to be refused') as never;
}

// The valid mandate's payload and disclosures behind another header, with an
// empty signature or an HMAC under `hmacSecret`
function resignedMandate(header: Record<string, unknown>, hmacSecret?: string): string {
  const [token, ...disclosures] = validPresentation.split('~');
  const payload = (token as string).split('.')[1] as string;
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payload}`;
  const signature =
    hmacSecret === undefined
      ? ''
      : createHmac('sha256', hmacSecret).update(signingInput).digest('base64url');
  return [`${signingInput}.${signature}`, ...disclosures].join('~');
}

// Every refusal here must be an authorization failure, never a payment one
async function expectRefused(run: Promise<unknown>, reason?: string): Promise<CommerceError> {
  const error = await rejection(run);
  expect(error.code).toBe('AUTHORIZATION_INVALID');
  expect(error.httpStatus).toBe(403);
  expect(error.retryable).toBe(false);
  if (reason !== undefined) expect(error.details?.['reason']).toBe(reason);
  return error;
}

beforeAll(async () => {
  parties = await createParties();
  checkoutJwt = await signCheckoutJwt(parties.checkoutSigner);
  validPresentation = await mintMandate(parties.mandateSigner, checkoutJwt);
  verifier = verifierFor(configFor(parties));
});

describe('a valid Direct closed Checkout Mandate', () => {
  it('verifies and reports both issuers and the checkout identity', async () => {
    const result = await verifier.verify(validPresentation);
    expect(result.mandateIssuer).toBe(MANDATE_ISSUER);
    expect(result.checkoutIssuer).toBe(CHECKOUT_ISSUER);
    expect(result.checkoutJwtId).toBe('checkout_01KTEST');
  });

  it('resolves the selectively disclosed checkout JWT into the mandate claims', async () => {
    const mandate = await verifyMandate(
      validPresentation,
      {
        trust: createTrustStore(parties.mandateIssuers),
        clock: fixedClock(),
        clockSkewSeconds: 60,
      },
      {},
    );
    expect(mandate.claims['checkout_jwt']).toBe(checkoutJwt);
    expect(mandate.claims['vct']).toBe('mandate.checkout.1');
  });

  it('hands back the checkout profile the purchase binding will read', async () => {
    const result = await verifier.verify(validPresentation);
    expect(result.checkoutClaims['agent_commerce']).toMatchObject({
      resource_id: 'market_report',
      amount: '0.01',
      currency: 'USDC',
      payment_method: 'x402',
    });
  });

  it('verifies a second time without the key cache changing the answer', async () => {
    const first = await verifier.verify(validPresentation);
    expect(await verifier.verify(validPresentation)).toEqual(first);
  });

  it('reports its trusted issuers for diagnostics without exposing keys', () => {
    const issuers = verifier.trustedIssuers();
    expect(issuers.mandate).toEqual([MANDATE_ISSUER]);
    expect(issuers.checkout).toEqual([CHECKOUT_ISSUER]);
    expect(JSON.stringify(issuers)).not.toContain('"x"');
  });
});

describe('malformed presentations', () => {
  it.each([
    ['empty', ''],
    ['not a JWT at all', 'hello~'],
    ['a JWT with no disclosure separator', 'a.b.c'],
    ['a truncated JWS', 'eyJhbGciOiJFUzI1NiJ9.eyJ2Y3QiOiJ4In0~'],
  ])('refuses one that is %s', async (_label, value) => {
    await expectRefused(verifier.verify(value), 'malformed_presentation');
  });

  it('refuses an undecodable disclosure', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      extraDisclosures: ['!!!not-base64!!!'],
    });
    await expectRefused(verifier.verify(presentation), 'malformed_presentation');
  });

  it('refuses a disclosure appended that no digest in the payload references', async () => {
    // The forged-claim attack: append `[salt, "amount", "0.01"]` and hope the
    // verifier merges it in without checking it was ever committed to
    const forged = disclosure('salt-forged', 'amount', '0.01');
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      extraDisclosures: [forged],
    });
    await expectRefused(verifier.verify(presentation), 'malformed_presentation');
  });

  it('refuses the same disclosure presented twice', async () => {
    const twice = disclosure('salt-checkout', 'checkout_jwt', checkoutJwt);
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      extraDisclosures: [twice],
    });
    await expectRefused(verifier.verify(presentation), 'malformed_presentation');
  });

  it('refuses a digest algorithm other than sha-256 rather than assuming sha-256', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { _sd_alg: 'sha-512' },
    });
    await expectRefused(verifier.verify(presentation), 'malformed_presentation');
  });
});

describe('signature and trust', () => {
  it('refuses a tampered payload', async () => {
    const [header, payload, signature, ...rest] = validPresentation.split(/[.~]/);
    const patched = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload as string, 'base64url').toString()),
        aud: 'someone.else',
      }),
    ).toString('base64url');
    await expectRefused(
      verifier.verify(`${header}.${patched}.${signature}~${rest.join('~')}`),
      'invalid_signature',
    );
  });

  it('refuses a mandate from an issuer that is not configured', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { iss: 'https://attacker.example' },
    });
    await expectRefused(verifier.verify(presentation), 'untrusted_issuer');
  });

  it('refuses a kid the configured issuer does not have', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      header: { kid: 'some-other-key' },
    });
    await expectRefused(verifier.verify(presentation), 'unknown_key');
  });

  it('selects the issuer by kid when the mandate names none', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { iss: undefined },
    });
    expect((await verifier.verify(presentation)).mandateIssuer).toBe(MANDATE_ISSUER);
  });

  it('refuses an issuerless mandate whose kid two trusted issuers share', async () => {
    const shared = configFor(parties, {
      trust: {
        mandateIssuers: [
          ...parties.mandateIssuers,
          trustedIssuer('https://second-surface.example', MANDATE_AUDIENCE, parties.mandateSigner),
        ],
        checkoutIssuers: parties.checkoutIssuers,
      },
    });
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { iss: undefined },
    });
    await expectRefused(verifierFor(shared).verify(presentation), 'unknown_key');
    // With `iss` present the same configuration is unambiguous
    await expect(verifierFor(shared).verify(validPresentation)).resolves.toBeDefined();
  });

  it('refuses a presentation with no kid rather than guessing the only key', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      header: { kid: undefined },
    });
    await expectRefused(verifier.verify(presentation), 'unknown_key');
  });

  it('refuses a mandate signed by a key that is trusted for checkout documents only', async () => {
    // Signing the merchant's checkout documents must not confer the power to
    // issue mandates authorizing purchases from them. Issuer, audience and kid
    // all match the checkout trust entry, so only the list split refuses it.
    const presentation = await mintMandate(parties.checkoutSigner, checkoutJwt, {
      payloadOverrides: { iss: CHECKOUT_ISSUER, aud: CHECKOUT_AUDIENCE },
    });
    await expectRefused(verifier.verify(presentation), 'untrusted_issuer');
  });

  it('refuses a mandate signed by a stranger under a trusted issuer and kid', async () => {
    const presentation = await mintMandate(
      { ...parties.stranger, kid: parties.mandateSigner.kid },
      checkoutJwt,
    );
    await expectRefused(verifier.verify(presentation), 'invalid_signature');
  });

  it('refuses alg=none', async () => {
    const presentation = resignedMandate({ alg: 'none', kid: parties.mandateSigner.kid });
    await expectRefused(verifier.verify(presentation), 'invalid_signature');
  });

  it('refuses HS256 forged with the public key as the HMAC secret', async () => {
    // Refused twice over (allowlist, and an EC key cannot do HMAC); this
    // asserts the outcome, not which one got there first
    const publicPem = createPublicKey({ key: parties.mandateSigner.publicJwk, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const presentation = resignedMandate(
      { alg: 'HS256', kid: parties.mandateSigner.kid },
      publicPem,
    );
    await expectRefused(verifier.verify(presentation), 'invalid_signature');
  });
});

describe('mandate claims', () => {
  it.each([
    ['the open variant', 'mandate.checkout.open.1'],
    ['an unversioned type', 'mandate.checkout'],
    ['a future version', 'mandate.checkout.2'],
    ['a prefix extension', 'mandate.checkout.1x'],
  ])('refuses %s', async (_label, vct) => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      mandateOverrides: { vct },
    });
    await expectRefused(verifier.verify(presentation), 'unsupported_mandate_type');
  });

  it('reads the mandate type from the delegated element, not the credential type above it', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { vct: 'com.example.agent_mandate' },
    });
    await expect(verifier.verify(presentation)).resolves.toBeDefined();
  });

  it('refuses a mandate addressed to a different merchant', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { aud: 'other-merchant.example' },
    });
    await expectRefused(verifier.verify(presentation), 'wrong_audience');
  });

  it('refuses an expired mandate', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { exp: Math.floor(NOW.getTime() / 1000) - 600 },
    });
    await expectRefused(verifier.verify(presentation), 'expired');
  });

  it('refuses a mandate that is not yet valid', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { nbf: Math.floor(NOW.getTime() / 1000) + 600 },
    });
    await expectRefused(verifier.verify(presentation), 'expired');
  });

  // AP2 makes `aud`, `iat` and `exp` optional; the reference SDK mints none
  it.each([
    ['aud', { aud: undefined }],
    ['iat', { iat: undefined }],
    ['exp', { exp: undefined }],
  ])('accepts a mandate with no %s by default', async (_claim, payloadOverrides) => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides,
    });
    await expect(verifier.verify(presentation)).resolves.toBeDefined();
  });

  it('refuses a mandate with no aud when the operator requires one', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { aud: undefined },
    });
    const strict = verifierFor(configFor(parties, { requireMandateAudience: true }));
    await expectRefused(strict.verify(presentation), 'invalid_claims');
    await expect(strict.verify(validPresentation)).resolves.toBeDefined();
  });

  it('refuses a mandate with no exp anywhere when the operator requires one', async () => {
    const strict = verifierFor(configFor(parties, { requireMandateExpiry: true }));
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { exp: undefined },
    });
    await expectRefused(strict.verify(presentation), 'invalid_claims');

    // The mandate content's own `exp` satisfies the requirement
    const inContent = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { exp: undefined },
      mandateOverrides: { exp: Math.floor(NOW.getTime() / 1000) + 300 },
    });
    await expect(strict.verify(inContent)).resolves.toBeDefined();
  });

  it.each([
    ['an expired exp', { exp: Math.floor(NOW.getTime() / 1000) - 600 }],
    ['an iat in the future', { iat: Math.floor(NOW.getTime() / 1000) + 600 }],
  ])('refuses %s inside the mandate content', async (_label, mandateOverrides) => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      mandateOverrides,
    });
    await expectRefused(verifier.verify(presentation), 'expired');
  });

  it('refuses a non-numeric exp inside the mandate content', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      mandateOverrides: { exp: 'tomorrow' },
    });
    await expectRefused(verifier.verify(presentation), 'invalid_claims');
  });

  it('refuses a mandate issued in the future', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { iat: Math.floor(NOW.getTime() / 1000) + 600 },
    });
    await expectRefused(verifier.verify(presentation), 'expired');
  });

  it('accepts an expiry inside the configured clock skew', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { exp: Math.floor(NOW.getTime() / 1000) - 30 },
    });
    await expect(verifier.verify(presentation)).resolves.toBeDefined();
  });

  it('refuses an expiry just outside it', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: { exp: Math.floor(NOW.getTime() / 1000) - 90 },
    });
    await expectRefused(verifier.verify(presentation), 'expired');
  });

  it('refuses a key-binding JWT rather than ignoring a proof that was sent', async () => {
    await expectRefused(
      verifier.verify(`${validPresentation}eyJhbGciOiJFUzI1NiJ9.eyJub25jZSI6IngifQ.sig`),
      'unsupported_mandate_type',
    );
  });

  it.each([
    ['mandate', { mandateOverrides: { cnf: { jwk: { kty: 'EC' } } } }],
    ['token', { payloadOverrides: { cnf: { jwk: { kty: 'EC' } } } }],
  ])('rejects an unsupported cnf binding in the %s', async (_label, opts) => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, opts);
    await expectRefused(verifier.verify(presentation), 'unsupported_mandate_type');
  });

  it('refuses a delegation chain outside Direct mode', async () => {
    await expectRefused(
      verifier.verify(`${validPresentation}~${validPresentation}`),
      'unsupported_mandate_type',
    );
  });
});

describe('the delegated mandate', () => {
  it('refuses mandate claims at the top level with no delegate_payload', async () => {
    // Legacy shape with mandate claims at the top level
    const checkoutDisclosure = disclosure('salt-checkout', 'checkout_jwt', checkoutJwt);
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      payloadOverrides: {
        delegate_payload: undefined,
        vct: 'mandate.checkout.1',
        checkout_hash: await sha256Base64url(checkoutJwt),
        _sd: [await sha256Base64url(checkoutDisclosure)],
      },
      withholdMandateDisclosure: true,
    });
    await expectRefused(verifier.verify(presentation), 'unsupported_mandate_type');
  });

  it('refuses a presentation that discloses no mandate', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      withholdMandateDisclosure: true,
      withholdCheckoutDisclosure: true,
    });
    await expectRefused(verifier.verify(presentation), 'invalid_claims');
  });

  it('refuses two delegated elements rather than choosing one', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      extraDelegateElements: [{ vct: 'mandate.payment.1' }],
    });
    await expectRefused(verifier.verify(presentation), 'invalid_claims');
  });
});

describe('the merchant checkout JWT', () => {
  it('refuses a mandate whose checkout disclosure was withheld', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      withholdCheckoutDisclosure: true,
    });
    await expectRefused(verifier.verify(presentation), 'invalid_claims');
  });

  it('refuses a swapped checkout JWT whose disclosure the mandate never committed to', async () => {
    // A genuine merchant document for a different purchase. Its disclosure
    // digest is not in the signed `_sd`, so it fails before `checkout_hash`;
    // the checkout_hash cases below keep the disclosure and change the hash.
    const other = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ jti: 'checkout_OTHER' }),
    );
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      checkoutJwtOverride: other,
    });
    await expectRefused(verifier.verify(presentation), 'malformed_presentation');
  });

  it('refuses a checkout_hash that does not match the bound document', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      mandateOverrides: { checkout_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    await expectRefused(verifier.verify(presentation), 'checkout_binding_failed');
  });

  it('refuses a mandate carrying no checkout_hash at all', async () => {
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      mandateOverrides: { checkout_hash: undefined },
    });
    await expectRefused(verifier.verify(presentation), 'invalid_claims');
  });

  it('refuses a checkout JWT signed by an untrusted party', async () => {
    const forged = await signCheckoutJwt(
      { ...parties.stranger, kid: parties.checkoutSigner.kid },
      checkoutPayload(),
    );
    const presentation = await mintMandate(parties.mandateSigner, forged);
    await expectRefused(verifier.verify(presentation), 'checkout_binding_failed');
  });

  it('refuses a checkout JWT from an issuer that is not configured', async () => {
    const foreign = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ iss: 'https://not-the-merchant.example' }),
    );
    const presentation = await mintMandate(parties.mandateSigner, foreign);
    await expectRefused(verifier.verify(presentation), 'untrusted_issuer');
  });

  it('refuses a checkout JWT addressed to someone other than the gateway', async () => {
    const misaddressed = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ aud: 'somewhere.else' }),
    );
    const presentation = await mintMandate(parties.mandateSigner, misaddressed);
    await expectRefused(verifier.verify(presentation), 'checkout_binding_failed');
  });

  it('refuses an expired checkout JWT even under a live mandate', async () => {
    const stale = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ exp: Math.floor(NOW.getTime() / 1000) - 600 }),
    );
    const presentation = await mintMandate(parties.mandateSigner, stale);
    await expectRefused(verifier.verify(presentation), 'checkout_binding_failed');
  });

  it('refuses a checkout JWT issued in the future', async () => {
    const early = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({
        iat: Math.floor(NOW.getTime() / 1000) + 600,
        exp: Math.floor(NOW.getTime() / 1000) + 900,
      }),
    );
    const presentation = await mintMandate(parties.mandateSigner, early);
    await expectRefused(verifier.verify(presentation), 'expired');
  });

  it.each([
    ['no exp', { exp: undefined }],
    ['no iat', { iat: undefined }],
    ['no jti', { jti: undefined }],
    ['an empty jti', { jti: '' }],
  ])('refuses a checkout JWT with %s', async (_label, override) => {
    const jwt = await signCheckoutJwt(parties.checkoutSigner, checkoutPayload(override));
    const presentation = await mintMandate(parties.mandateSigner, jwt);
    await expectRefused(verifier.verify(presentation), 'invalid_claims');
  });

  it('refuses a mandate and a checkout JWT that are each valid but unrelated', async () => {
    // Both documents genuine, neither binding the other
    const unrelated = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ jti: 'checkout_UNRELATED' }),
    );
    const presentation = await mintMandate(parties.mandateSigner, checkoutJwt, {
      mandateOverrides: { checkout_hash: await sha256Base64url(unrelated) },
    });
    await expectRefused(verifier.verify(presentation), 'checkout_binding_failed');
  });
});

describe('error reporting', () => {
  it('never leaks mandate content into a client-visible message', async () => {
    const secret = 'buyer@example.com-and-their-order-history';
    const jwt = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ buyer_email: secret, aud: 'wrong' }),
    );
    const presentation = await mintMandate(parties.mandateSigner, jwt);
    const error = await expectRefused(verifier.verify(presentation));
    const onTheWire = JSON.stringify(error.toInfo());
    expect(onTheWire).not.toContain(secret);
    expect(onTheWire).not.toContain(presentation.slice(0, 40));
  });

  it('carries the request id so the refusal correlates with the rest of the flow', async () => {
    const error = await expectRefused(verifier.verify('nonsense~', { requestId: 'req-9' }));
    expect(error.requestId).toBe('req-9');
  });

  it('reports a broken configured key as our fault, not the buyer', async () => {
    // Config would refuse this key, so reaching the verifier means our
    // deployment is broken. Blaming the payer burns a mandate that is fine.
    const broken = configFor(parties, {
      trust: {
        mandateIssuers: [
          {
            issuer: MANDATE_ISSUER,
            audience: MANDATE_AUDIENCE,
            keys: [{ kid: parties.mandateSigner.kid, jwk: { kty: 'EC', crv: 'P-256', x: 'nope' } }],
          },
        ],
        checkoutIssuers: parties.checkoutIssuers,
      },
    });
    const error = await rejection(verifierFor(broken).verify(validPresentation));
    expect(error.code).toBe('AUTHORIZATION_PROVIDER_UNAVAILABLE');
    expect(error.httpStatus).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe('trust list separation', () => {
  it('does not accept a mandate issuer as a checkout issuer', async () => {
    const config = configFor(parties, {
      trust: {
        mandateIssuers: parties.mandateIssuers,
        // Only the mandate issuer is trusted for checkout documents now
        checkoutIssuers: [trustedIssuer(MANDATE_ISSUER, CHECKOUT_AUDIENCE, parties.mandateSigner)],
      },
    });
    await expectRefused(verifierFor(config).verify(validPresentation), 'untrusted_issuer');
  });
});
