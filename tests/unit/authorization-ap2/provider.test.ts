/**
 * The provider is the seam between core's generic contract and the mandate
 * machinery. These own what that seam is responsible for: the right error code
 * for each kind of failure, the reservation lifecycle, and a health probe that
 * tells the truth about a store it cannot read.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AP2_CHECKOUT_PROFILE,
  AP2_SPEC_VERSION,
} from '../../../src/authorization/ap2/constants.js';
import { AP2_UNSUPPORTED } from '../../../src/authorization/ap2/descriptor.js';
import { computeInputHash } from '../../../src/authorization/ap2/profile.js';
import {
  type Ap2AuthorizationProvider,
  createAp2AuthorizationProvider,
} from '../../../src/authorization/ap2/provider.js';
import {
  type Ap2ReplayStore,
  createAp2ReplayStore,
} from '../../../src/authorization/ap2/replay-store.js';
import type { EnabledAp2Config } from '../../../src/authorization/ap2/types.js';
import type {
  AuthorizationVerificationContext,
  PaymentRequirement,
} from '../../../src/core/index.js';
import { isCommerceError } from '../../../src/core/index.js';
import {
  checkoutPayload,
  createParties,
  fixedClock,
  mintMandate,
  type Party,
  signCheckoutJwt,
} from './fixtures.js';

const RESOURCE_ID = 'market_report';
const INPUT = { city: 'Berlin' };

let parties: Party;
let inputHash: string;

function config(overrides: Partial<EnabledAp2Config> = {}): EnabledAp2Config {
  return {
    enabled: true,
    specVersion: '0.2.0',
    mode: 'direct',
    trust: { mandateIssuers: parties.mandateIssuers, checkoutIssuers: parties.checkoutIssuers },
    clockSkewSeconds: 60,
    replay: { path: ':memory:' },
    ...overrides,
  };
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
    challenge: { provider: 'x402', version: '2', accepts: [] },
  };
}

function context(payload: string, requestId = 'req-1'): AuthorizationVerificationContext {
  return {
    requestId,
    resourceId: RESOURCE_ID,
    input: INPUT,
    submission: { method: 'ap2', payload },
    requirement: requirement(),
  };
}

// A mandate that authorizes exactly the purchase `requirement()` describes
async function validMandate(overrides: Record<string, unknown> = {}): Promise<string> {
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({
      agent_commerce: {
        profile: AP2_CHECKOUT_PROFILE,
        resource_id: RESOURCE_ID,
        input_hash: inputHash,
        amount: '0.01',
        currency: 'USDC',
        payment_method: 'x402',
        // Required whenever the requirement names one, which x402 always does
        destination: '0xMERCHANT',
        ...overrides,
      },
    }),
  );
  return mintMandate(parties.mandateSigner, jwt);
}

function makeProvider(replayStore?: Ap2ReplayStore): Ap2AuthorizationProvider {
  return createAp2AuthorizationProvider({
    config: config(),
    clock: fixedClock(),
    ...(replayStore !== undefined ? { replayStore } : {}),
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return isCommerceError(error) ? error.code : `untyped:${String(error)}`;
  }
  return 'no-error';
}

beforeAll(async () => {
  parties = await createParties();
  inputHash = await computeInputHash(INPUT);
});

describe('createAp2AuthorizationProvider', () => {
  it('describes itself as an experimental authorization adapter', () => {
    const provider = makeProvider();
    expect(provider.name).toBe('ap2');
    expect(provider.descriptor.kind).toBe('authorization');
    expect(provider.descriptor.status).toBe('experimental');
    expect(provider.descriptor.supportedSpec).toContain(AP2_SPEC_VERSION);
    expect(provider.descriptor.capabilities).toContain('direct-mode');
    provider.close();
  });

  it('names what it does not do, rather than summarising it as a count', () => {
    const provider = makeProvider();
    expect(provider.descriptor.unsupported).toEqual(AP2_UNSUPPORTED);
    // The two an operator is most likely to assume they have
    expect(AP2_UNSUPPORTED).toContain('autonomous mode');
    expect(AP2_UNSUPPORTED).toContain('open checkout mandates (mandate.checkout.open.1)');
    expect(AP2_UNSUPPORTED).not.toContain('merchant checkout JWT issuance');
    provider.close();
  });

  it('advertises the spec version and the profile a retry must carry', () => {
    const provider = makeProvider();
    expect(provider.requirement).toEqual({
      method: 'ap2',
      version: AP2_SPEC_VERSION,
      profile: AP2_CHECKOUT_PROFILE,
    });
    provider.close();
  });

  it('verifies a mandate, reserves it, and returns a digest rather than the proof', async () => {
    const provider = makeProvider();
    const presentation = await validMandate();

    const verification = await provider.verifyAndReserve(context(presentation));

    expect(verification.status).toBe('verified');
    expect(verification.method).toBe('ap2');
    expect(verification.reference).toMatch(/^sha256:[\w-]+$/);
    // One digest, used as both the audit identity and the reservation handle,
    // so the two can never name different mandates
    expect(verification.reservationId).toBe(verification.reference);
    expect(JSON.stringify(verification)).not.toContain(presentation);
    provider.close();
  });

  it('records only opaque identifiers on the verification, never mandate claims', async () => {
    const provider = makeProvider();

    const verification = await provider.verifyAndReserve(context(await validMandate()));

    expect(verification.metadata).toEqual({
      mandateIssuer: 'https://trusted-surface.example',
      checkoutIssuer: 'https://merchant.example',
      checkoutId: 'checkout_01KTEST',
    });
    // The receipt store redacts any key that reads as secret-shaped, so a
    // field named for the JWT would persist as [REDACTED]
    expect(Object.keys(verification.metadata ?? {})).not.toContain('checkoutJwtId');
    provider.close();
  });

  it('refuses a second presentation of one mandate as replayed, not as invalid', async () => {
    const provider = makeProvider();
    const presentation = await validMandate();

    await provider.verifyAndReserve(context(presentation));
    const code = await codeOf(() => provider.verifyAndReserve(context(presentation, 'req-2')));

    expect(code).toBe('AUTHORIZATION_REPLAYED');
    provider.close();
  });

  it('refuses a mandate for a different purchase as invalid', async () => {
    const provider = makeProvider();
    const presentation = await validMandate({ amount: '500.00' });

    const code = await codeOf(() => provider.verifyAndReserve(context(presentation)));

    expect(code).toBe('AUTHORIZATION_INVALID');
    provider.close();
  });

  it('refuses a mandate from an untrusted issuer as invalid', async () => {
    const provider = makeProvider();
    const jwt = await signCheckoutJwt(parties.checkoutSigner, checkoutPayload());
    const presentation = await mintMandate(parties.stranger, jwt);

    const code = await codeOf(() => provider.verifyAndReserve(context(presentation)));

    expect(code).toBe('AUTHORIZATION_INVALID');
    provider.close();
  });

  it('does not reserve a mandate that fails to bind to the purchase', async () => {
    const reserved: string[] = [];
    const provider = makeProvider(recordingStore(reserved));
    const presentation = await validMandate({ amount: '9.99' });

    await codeOf(() => provider.verifyAndReserve(context(presentation)));

    // Otherwise the buyer's own mandate is spent by the purchase it does not
    // authorize, and unusable for the one it does
    expect(reserved).toEqual([]);
    provider.close();
  });

  it('reports a replay-store failure as unavailable, not as a bad mandate', async () => {
    const provider = makeProvider(throwingStore());
    const presentation = await validMandate();

    const code = await codeOf(() => provider.verifyAndReserve(context(presentation)));

    expect(code).toBe('AUTHORIZATION_PROVIDER_UNAVAILABLE');
    provider.close();
  });

  describe('finalization', () => {
    it('moves a reservation to consumed, released or uncertain', async () => {
      for (const [action, expected] of [
        ['consume', 'consumed'],
        ['release', 'released'],
        ['markUncertain', 'uncertain'],
      ] as const) {
        const store = createAp2ReplayStore({ path: ':memory:' });
        const provider = makeProvider(store);
        const verification = await provider.verifyAndReserve(context(await validMandate()));

        await provider[action](verification.reservationId, {
          requestId: 'req-1',
          resourceId: RESOURCE_ID,
        });

        expect(store.stateOf(verification.reference)).toBe(expected);
        provider.close();
      }
    });

    it('lets a released mandate authorize a corrected retry', async () => {
      const store = createAp2ReplayStore({ path: ':memory:' });
      const provider = makeProvider(store);
      const presentation = await validMandate();
      const first = await provider.verifyAndReserve(context(presentation));
      await provider.release(first.reservationId, {
        requestId: 'req-1',
        resourceId: RESOURCE_ID,
      });

      const second = await provider.verifyAndReserve(context(presentation, 'req-2'));

      expect(second.reference).toBe(first.reference);
      provider.close();
    });

    it('reports a store failure during finalization as unavailable', async () => {
      const provider = makeProvider(throwingStore());

      const code = await codeOf(() =>
        provider.consume('sha256:whatever', { requestId: 'req-1', resourceId: RESOURCE_ID }),
      );

      expect(code).toBe('AUTHORIZATION_PROVIDER_UNAVAILABLE');
      provider.close();
    });
  });

  describe('health', () => {
    it('passes and reports how many issuers are trusted, never a key', async () => {
      const provider = makeProvider();

      const health = await provider.health();

      expect(health.status).toBe('pass');
      expect(health.detail).toBe('mandate-issuers=1 checkout-issuers=1');
      expect(JSON.stringify(health)).not.toContain(parties.mandateSigner.publicJwk['x']);
      provider.close();
    });

    it('fails with a fixed token when the replay store cannot be read', async () => {
      const provider = makeProvider(throwingStore());

      const health = await provider.health();

      expect(health.status).toBe('fail');
      // A fixed vocabulary token, never a sentence built from the caught error
      expect(health.detail).toBe('replay-store-unavailable');
      provider.close();
    });
  });
});

function throwingStore(): Ap2ReplayStore {
  const boom = (): never => {
    throw new Error('sqlite: disk I/O error');
  };
  return {
    reserve: boom,
    consume: boom,
    release: boom,
    markUncertain: boom,
    stateOf: boom,
    close: () => {},
  };
}

function recordingStore(reserved: string[]): Ap2ReplayStore {
  const inner = createAp2ReplayStore({ path: ':memory:' });
  return {
    ...inner,
    reserve(request) {
      reserved.push(request.reference);
      return inner.reserve(request);
    },
  };
}
