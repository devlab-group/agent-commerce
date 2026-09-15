/**
 * Binding a verified mandate to the purchase in front of us, and spending it
 * exactly once.
 *
 * The verifier proves a mandate is genuine, which on its own authorises
 * nothing: a genuine mandate for a $0.01 report would unlock a $500 one. These
 * own the comparison that stops that, and the reservation that stops one
 * approval paying twice.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AP2_CHECKOUT_PROFILE } from '../../../src/authorization/ap2/constants.js';
import { bindMandateToPurchase, computeInputHash } from '../../../src/authorization/ap2/profile.js';
import { createAp2ReplayStore } from '../../../src/authorization/ap2/replay-store.js';
import {
  type Ap2MandateVerifier,
  createAp2MandateVerifier,
} from '../../../src/authorization/ap2/verifier.js';
import type {
  AuthorizationVerificationContext,
  CommerceError,
  PaymentRequirement,
} from '../../../src/core/index.js';
import { isCommerceError } from '../../../src/core/index.js';
import {
  assemblePresentation,
  checkoutPayload,
  createParties,
  fixedClock,
  mintMandate,
  mintMandateParts,
  type Party,
  signCheckoutJwt,
} from './fixtures.js';

const RESOURCE_ID = 'market_report';
const INPUT = { city: 'Berlin', detail: { depth: 2, tags: ['a', 'b'] } };

let parties: Party;
let verifier: Ap2MandateVerifier;
let inputHash: string;

function requirement(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    id: 'pr-1',
    requestId: 'req-1',
    resourceId: RESOURCE_ID,
    provider: 'x402',
    amount: '0.01',
    currency: 'USDC',
    destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    network: 'eip155:84532',
    asset: '0x1111111111111111111111111111111111111111',
    challenge: { provider: 'x402', version: '2', accepts: [] },
    ...overrides,
  };
}

// A requirement for a rail with no chain coordinates at all
function requirementWithoutCoordinates(): PaymentRequirement {
  const { network: _n, asset: _a, ...rest } = requirement();
  return rest;
}

function context(
  overrides: Partial<AuthorizationVerificationContext> = {},
): AuthorizationVerificationContext {
  return {
    requestId: 'req-1',
    resourceId: RESOURCE_ID,
    input: INPUT,
    submission: { method: 'ap2', payload: 'unused-here' },
    requirement: requirement(),
    ...overrides,
  };
}

// The checkout profile a correctly minted mandate carries for this purchase
function profileClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: AP2_CHECKOUT_PROFILE,
    resource_id: RESOURCE_ID,
    input_hash: inputHash,
    amount: '0.01',
    currency: 'USDC',
    payment_method: 'x402',
    destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    network: 'eip155:84532',
    asset: '0x1111111111111111111111111111111111111111',
    ...overrides,
  };
}

// Mints a mandate whose checkout JWT carries `agent_commerce`
async function mandateFor(profile: Record<string, unknown>): Promise<string> {
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({ agent_commerce: profile }),
  );
  return mintMandate(parties.mandateSigner, jwt);
}

async function bindRejection(
  presentation: string,
  ctx: AuthorizationVerificationContext = context(),
): Promise<CommerceError> {
  const verified = await verifier.verify(presentation);
  try {
    await bindMandateToPurchase(verified, ctx, {});
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    return error as CommerceError;
  }
  return expect.unreachable('expected the mandate to be refused') as never;
}

beforeAll(async () => {
  parties = await createParties();
  inputHash = await computeInputHash(INPUT);
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
});

describe('the RFC 8785 input hash', () => {
  it('does not depend on the order keys were written in', async () => {
    // Their signer hashed the buyer's request, we hash what arrived. Same
    // content in a different key order is the same request.
    const a = await computeInputHash({ city: 'Berlin', depth: 2 });
    const b = await computeInputHash({ depth: 2, city: 'Berlin' });
    expect(a).toBe(b);
  });

  it('is stable through nesting', async () => {
    const a = await computeInputHash({ outer: { x: 1, y: { p: 'a', q: 'b' } } });
    const b = await computeInputHash({ outer: { y: { q: 'b', p: 'a' }, x: 1 } });
    expect(a).toBe(b);
  });

  it('does depend on array order, because a reordered list is a different request', async () => {
    const a = await computeInputHash({ tags: ['a', 'b'] });
    const b = await computeInputHash({ tags: ['b', 'a'] });
    expect(a).not.toBe(b);
  });

  it.each([
    ['a changed value', { city: 'Paris' }],
    ['an added field', { city: 'Berlin', extra: 1 }],
    ['a number where a string was', { city: 1 }],
    ['an empty object', {}],
  ])('changes for %s', async (_label, input) => {
    expect(await computeInputHash(input)).not.toBe(await computeInputHash({ city: 'Berlin' }));
  });

  it('treats absent input as the empty object rather than failing', async () => {
    expect(await computeInputHash(undefined)).toBe(await computeInputHash({}));
  });
});

describe('binding a mandate to the resolved purchase', () => {
  it('accepts a mandate that authorises exactly this purchase', async () => {
    const verified = await verifier.verify(await mandateFor(profileClaims()));
    await expect(bindMandateToPurchase(verified, context(), {})).resolves.toEqual({
      resourceId: RESOURCE_ID,
      amount: '0.01',
      currency: 'USDC',
      paymentMethod: 'x402',
    });
  });

  it.each([
    ['a different profile', { profile: 'agent-commerce/ap2/checkout/v2' }],
    ['a different resource', { resource_id: 'weather_basic' }],
    ['a different input', { input_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    ['a different amount', { amount: '500.00' }],
    ['the same amount written differently', { amount: '0.010' }],
    ['a different currency', { currency: 'EUR' }],
    ['a different payment method', { payment_method: 'card' }],
    ['a different destination', { destination: '0x000000000000000000000000000000000000dEaD' }],
    ['a different network', { network: 'eip155:8453' }],
    ['a different asset', { asset: '0x2222222222222222222222222222222222222222' }],
  ])('refuses one carrying %s', async (_label, override) => {
    const error = await bindRejection(await mandateFor(profileClaims(override)));
    expect(error.code).toBe('AUTHORIZATION_INVALID');
    expect(error.details?.['reason']).toBe('purchase_mismatch');
  });

  it.each(['profile', 'resource_id', 'input_hash', 'amount', 'currency', 'payment_method'])(
    'refuses one that omits %s rather than skipping the check',
    async (claim) => {
      const claims = profileClaims();
      delete claims[claim];
      await bindRejection(await mandateFor(claims));
    },
  );

  it('refuses a mandate with no checkout profile at all', async () => {
    const jwt = await signCheckoutJwt(parties.checkoutSigner, checkoutPayload());
    const presentation = await mintMandate(parties.mandateSigner, jwt);
    // The default fixture profile has a placeholder input hash, so this is
    // also the "mandate for some other request" case
    await bindRejection(presentation);
  });

  it('refuses a profile that is not an object', async () => {
    const jwt = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ agent_commerce: 'agent-commerce/ap2/checkout/v1' }),
    );
    await bindRejection(await mintMandate(parties.mandateSigner, jwt));
  });

  it('refuses a mandate silent about the chain when the requirement names one', async () => {
    // A mandate that does not say which chain it authorises must not unlock a
    // mainnet settlement
    const claims = profileClaims();
    delete claims['network'];
    await bindRejection(await mandateFor(claims));
  });

  it('refuses a mandate naming a chain when the requirement has none', async () => {
    const ctx = context({ requirement: requirementWithoutCoordinates() });
    await bindRejection(await mandateFor(profileClaims()), ctx);
  });

  it('accepts when neither side names settlement coordinates', async () => {
    const claims = profileClaims();
    for (const key of ['network', 'asset']) delete claims[key];
    const ctx = context({ requirement: requirementWithoutCoordinates() });
    const verified = await verifier.verify(await mandateFor(claims));
    await expect(bindMandateToPurchase(verified, ctx, {})).resolves.toBeDefined();
  });

  it('does not report which field disagreed', async () => {
    // Asking one field at a time reads a mandate out by elimination
    const error = await bindRejection(await mandateFor(profileClaims({ amount: '500.00' })));
    const onTheWire = JSON.stringify(error.toInfo());
    expect(onTheWire).not.toContain('500.00');
    expect(onTheWire).not.toContain('amount');
  });
});

describe('the replay identity of a mandate', () => {
  it('is the same however the mandate is presented', async () => {
    // The defect this design exists to avoid: keying replay on the
    // presentation string gives each disclosed subset its own identity, so one
    // approval could be spent once per subset
    const jwt = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ agent_commerce: profileClaims() }),
    );
    // Minted ONCE, presented two ways. Signing twice gives two different
    // tokens (fresh ES256 nonce) and would prove nothing.
    const parts = await mintMandateParts(parties.mandateSigner, jwt, {
      disclosable: { buyer_note: 'hello' },
    });
    const withNote = assemblePresentation(parts.signedToken, [
      parts.checkoutDisclosure,
      parts.optional['buyer_note'] as string,
    ]);
    const withoutNote = assemblePresentation(parts.signedToken, [parts.checkoutDisclosure]);

    expect(withNote).not.toBe(withoutNote);
    const a = await verifier.verify(withNote);
    const b = await verifier.verify(withoutNote);
    expect(a.reference).toBe(b.reference);
    // And the presentations really did differ in what they disclosed
    expect(a.mandateClaims['buyer_note']).toBe('hello');
    expect(b.mandateClaims['buyer_note']).toBeUndefined();
  });

  it('is a digest, carrying nothing readable from the mandate', async () => {
    const verified = await verifier.verify(await mandateFor(profileClaims()));
    expect(verified.reference).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it('differs between two mandates', async () => {
    const first = await verifier.verify(await mandateFor(profileClaims()));
    const second = await verifier.verify(
      await mandateFor(profileClaims({ input_hash: await computeInputHash({ city: 'Paris' }) })),
    );
    expect(first.reference).not.toBe(second.reference);
  });
});

describe('verify, bind and reserve together', () => {
  it('spends a mandate once and refuses every later presentation of it', async () => {
    const store = createAp2ReplayStore({ path: ':memory:' });
    const presentation = await mandateFor(profileClaims());

    const verified = await verifier.verify(presentation);
    await bindMandateToPurchase(verified, context(), {});
    const first = store.reserve({
      reference: verified.reference,
      checkoutJti: verified.checkoutJwtId,
      mandateIssuer: verified.mandateIssuer,
      checkoutIssuer: verified.checkoutIssuer,
      resourceId: RESOURCE_ID,
      requestId: 'req-1',
    });
    expect(first).toEqual({ kind: 'reserved' });
    store.consume(verified.reference);

    // Same mandate, second request: still valid, still bound, still refused
    const again = await verifier.verify(presentation);
    expect(again.reference).toBe(verified.reference);
    await expect(bindMandateToPurchase(again, context(), {})).resolves.toBeDefined();
    expect(
      store.reserve({
        reference: again.reference,
        checkoutJti: again.checkoutJwtId,
        mandateIssuer: again.mandateIssuer,
        checkoutIssuer: again.checkoutIssuer,
        resourceId: RESOURCE_ID,
        requestId: 'req-2',
      }),
    ).toEqual({ kind: 'replayed', state: 'consumed' });

    store.close();
  });

  it('refuses a re-presented mandate even when disclosed differently', async () => {
    const store = createAp2ReplayStore({ path: ':memory:' });
    const jwt = await signCheckoutJwt(
      parties.checkoutSigner,
      checkoutPayload({ agent_commerce: profileClaims() }),
    );
    const parts = await mintMandateParts(parties.mandateSigner, jwt, {
      disclosable: { buyer_note: 'hello' },
    });
    const full = assemblePresentation(parts.signedToken, [
      parts.checkoutDisclosure,
      parts.optional['buyer_note'] as string,
    ]);
    const trimmed = assemblePresentation(parts.signedToken, [parts.checkoutDisclosure]);

    const a = await verifier.verify(full);
    store.reserve({
      reference: a.reference,
      checkoutJti: a.checkoutJwtId,
      mandateIssuer: a.mandateIssuer,
      checkoutIssuer: a.checkoutIssuer,
      resourceId: RESOURCE_ID,
      requestId: 'req-1',
    });
    store.consume(a.reference);

    const b = await verifier.verify(trimmed);
    expect(
      store.reserve({
        reference: b.reference,
        checkoutJti: b.checkoutJwtId,
        mandateIssuer: b.mandateIssuer,
        checkoutIssuer: b.checkoutIssuer,
        resourceId: RESOURCE_ID,
        requestId: 'req-2',
      }),
    ).toEqual({ kind: 'replayed', state: 'consumed' });

    store.close();
  });
});
