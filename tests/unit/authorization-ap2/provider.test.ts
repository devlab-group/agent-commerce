/**
 * The provider is the seam between core's generic contract and the mandate
 * machinery. These own what that seam is responsible for: the right error code
 * for each kind of failure, the reservation lifecycle, and a health probe that
 * tells the truth about a store it cannot read.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AP2_CHECKOUT_PROFILE, AP2_SPEC_VERSION } from '../../../src/authorization/ap2/constants';
import { AP2_UNSUPPORTED } from '../../../src/authorization/ap2/descriptor';
import { computeInputHash } from '../../../src/authorization/ap2/profile';
import {
  type Ap2AuthorizationProvider,
  createAp2AuthorizationProvider,
} from '../../../src/authorization/ap2/provider';
import {
  type Ap2ReplayStore,
  createAp2ReplayStore,
} from '../../../src/authorization/ap2/replay-store';
import type { EnabledAp2Config } from '../../../src/authorization/ap2/types';
import type {
  AuthorizationVerificationContext,
  PaymentRequirement,
  ReceiptStore,
} from '../../../src/core';
import { isCommerceError } from '../../../src/core';
import { createSqliteReceiptStore, type SqliteReceiptStore } from '../../../src/storage/receipts';
import {
  checkoutPayload,
  createParties,
  fixedClock,
  mintMandate,
  type Party,
  signCheckoutJwt,
} from './fixtures';

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

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return 'no-error';
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  const error = await errorOf(run);
  return isCommerceError(error) ? error.code : `untyped:${String(error)}`;
}

beforeAll(async () => {
  parties = await createParties();
  inputHash = computeInputHash(INPUT);
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

  it('names what it does not do, rather than summarizing it as a count', () => {
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

    const error = await errorOf(() => provider.verifyAndReserve(context(presentation)));

    expect(error).toMatchObject({
      code: 'AUTHORIZATION_INVALID',
      details: { reason: 'purchase_mismatch' },
    });
    provider.close();
  });

  it('refuses a mandate from an untrusted issuer as invalid', async () => {
    const provider = makeProvider();
    const jwt = await signCheckoutJwt(parties.checkoutSigner, checkoutPayload());
    const presentation = await mintMandate(parties.stranger, jwt, {
      payloadOverrides: { iss: 'https://attacker.example' },
    });

    const error = await errorOf(() => provider.verifyAndReserve(context(presentation)));

    expect(error).toMatchObject({
      code: 'AUTHORIZATION_INVALID',
      details: { reason: 'untrusted_issuer' },
    });
    provider.close();
  });

  it('does not reserve a mandate that fails to bind to the purchase', async () => {
    const reserved: string[] = [];
    const provider = makeProvider(recordingStore(reserved));
    const presentation = await validMandate({ amount: '9.99' });

    const error = await errorOf(() => provider.verifyAndReserve(context(presentation)));

    expect(error).toMatchObject({ details: { reason: 'purchase_mismatch' } });
    // Otherwise the buyer's own mandate is spent by the purchase it does not
    // authorize, and unusable for the one it does
    expect(reserved).toEqual([]);
    // The same store does record a mandate that binds
    await provider.verifyAndReserve(context(await validMandate()));
    expect(reserved).toHaveLength(1);
    provider.close();
  });

  it('reports a replay-store failure as unavailable, not as a bad mandate', async () => {
    const provider = makeProvider(throwingStore());
    const presentation = await validMandate();

    const error = await errorOf(() => provider.verifyAndReserve(context(presentation)));

    expect(error).toMatchObject({
      code: 'AUTHORIZATION_PROVIDER_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
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

    it('finalizes only the reservation made by the named request', async () => {
      const store = createAp2ReplayStore({ path: ':memory:' });
      const provider = makeProvider(store);
      const presentation = await validMandate();
      const first = await provider.verifyAndReserve(context(presentation));
      await provider.release(first.reservationId, { requestId: 'req-1', resourceId: RESOURCE_ID });
      await provider.verifyAndReserve(context(presentation, 'req-2'));

      // A late release for req-1 must not free req-2's reservation
      await provider.release(first.reservationId, { requestId: 'req-1', resourceId: RESOURCE_ID });
      expect(store.stateOf(first.reference)).toBe('reserved');

      await provider.consume(first.reservationId, { requestId: 'req-2', resourceId: RESOURCE_ID });
      expect(store.stateOf(first.reference)).toBe('consumed');
      provider.close();
    });

    it('refuses to report a release of a consumed mandate as applied', async () => {
      const store = createAp2ReplayStore({ path: ':memory:' });
      const provider = makeProvider(store);
      const first = await provider.verifyAndReserve(context(await validMandate()));
      const finalize = { requestId: 'req-1', resourceId: RESOURCE_ID };
      await provider.consume(first.reservationId, finalize);

      const code = await codeOf(() => provider.release(first.reservationId, finalize));

      expect(code).toBe('AUTHORIZATION_PROVIDER_UNAVAILABLE');
      expect(store.stateOf(first.reference)).toBe('consumed');
      provider.close();
    });

    it('finalizes through a replay store whose transitions return nothing, as in 2.4', async () => {
      const inner = createAp2ReplayStore({ path: ':memory:' });
      const legacy: Ap2ReplayStore = {
        reserve: (request) => inner.reserve(request),
        consume: (reference, requestId) => {
          inner.consume(reference, requestId);
        },
        release: (reference, requestId) => {
          inner.release(reference, requestId);
        },
        markUncertain: (reference, requestId) => {
          inner.markUncertain(reference, requestId);
        },
        stateOf: (reference) => inner.stateOf(reference),
        close: () => inner.close(),
      };
      const provider = makeProvider(legacy);
      const first = await provider.verifyAndReserve(context(await validMandate()));

      await provider.consume(first.reservationId, { requestId: 'req-1', resourceId: RESOURCE_ID });

      expect(inner.stateOf(first.reference)).toBe('consumed');
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

    it('times the replay store probe', async () => {
      let elapsed = 0;
      const inner = createAp2ReplayStore({ path: ':memory:' });
      const slowStore: Ap2ReplayStore = {
        ...inner,
        stateOf(reference) {
          elapsed += 7;
          return inner.stateOf(reference);
        },
      };
      const provider = createAp2AuthorizationProvider({
        config: config(),
        clock: { ...fixedClock(), monotonicMs: () => elapsed },
        replayStore: slowStore,
      });

      expect((await provider.health()).durationMs).toBe(7);
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

describe('createAp2AuthorizationProvider on the receipt store', () => {
  let dir: string;
  let store: SqliteReceiptStore;
  const finalize = { requestId: 'req-1', resourceId: RESOURCE_ID };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ap2-provider-store-'));
    store = createSqliteReceiptStore({ path: ':memory:' });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const onStore = (target: ReceiptStore = store, overrides: Partial<EnabledAp2Config> = {}) =>
    createAp2AuthorizationProvider({
      config: config(overrides),
      clock: fixedClock(),
      store: target,
    });

  it('moves a hold to consumed, released or uncertain, and refuses a second presentation', async () => {
    for (const [action, expected] of [
      ['consume', 'consumed'],
      ['release', 'released'],
      ['markUncertain', 'uncertain'],
    ] as const) {
      await store.close();
      store = createSqliteReceiptStore({ path: ':memory:' });
      await store.init();
      const provider = onStore();
      const presentation = await validMandate();
      const verification = await provider.verifyAndReserve(context(presentation));
      expect(await store.getAuthorizationHoldState(verification.reference)).toBe('reserved');
      expect(await codeOf(() => provider.verifyAndReserve(context(presentation, 'req-2')))).toBe(
        'AUTHORIZATION_REPLAYED',
      );

      await provider[action](verification.reservationId, finalize);

      expect(await store.getAuthorizationHoldState(verification.reference)).toBe(expected);
      provider.close();
    }
  });

  it('stores the binding and the two issuers, and nothing from the mandate', async () => {
    const provider = onStore();
    const presentation = await validMandate();
    const verification = await provider.verifyAndReserve(context(presentation));

    const [hold] = await store.listOrphanAuthorizationHolds({
      updatedBefore: '2100-01-01T00:00:00.000Z',
    });
    expect(hold).toMatchObject({
      method: 'ap2',
      reference: verification.reference,
      bindingReference: 'checkout_01KTEST',
      resourceId: RESOURCE_ID,
      requestId: 'req-1',
      metadata: {
        mandateIssuer: 'https://trusted-surface.example',
        checkoutIssuer: 'https://merchant.example',
      },
    });
    expect(Object.keys(hold?.metadata ?? {})).toEqual(['mandateIssuer', 'checkoutIssuer']);
    expect(JSON.stringify(hold)).not.toContain(presentation);
    provider.close();
  });

  it('frees a released mandate for a retry, and a late release cannot free the new holder', async () => {
    const provider = onStore();
    const presentation = await validMandate();
    const first = await provider.verifyAndReserve(context(presentation));
    await provider.release(first.reservationId, finalize);
    await provider.verifyAndReserve(context(presentation, 'req-2'));

    await provider.release(first.reservationId, finalize);
    expect(await store.getAuthorizationHoldState(first.reference)).toBe('reserved');
    await provider.consume(first.reservationId, { requestId: 'req-2', resourceId: RESOURCE_ID });
    expect(await store.getAuthorizationHoldState(first.reference)).toBe('consumed');
    provider.close();
  });

  it('reports a release of a consumed hold as unavailable, leaving it consumed', async () => {
    const provider = onStore();
    const first = await provider.verifyAndReserve(context(await validMandate()));
    await provider.consume(first.reservationId, finalize);

    expect(await codeOf(() => provider.release(first.reservationId, finalize))).toBe(
      'AUTHORIZATION_PROVIDER_UNAVAILABLE',
    );
    expect(await store.getAuthorizationHoldState(first.reference)).toBe('consumed');
    provider.close();
  });

  it('reports a store that throws as unavailable, on reserve, finalize and health', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('sqlite: disk I/O error');
    };
    const broken: ReceiptStore = {
      ...store,
      reserveAuthorizationHold: boom,
      transitionAuthorizationHold: boom,
      getAuthorizationHoldState: boom,
      listOrphanAuthorizationHolds: boom,
    };
    const provider = onStore(broken);

    expect(await codeOf(() => provider.verifyAndReserve(context('ignored')))).toBe(
      'AUTHORIZATION_INVALID',
    );
    expect(await codeOf(async () => provider.verifyAndReserve(context(await validMandate())))).toBe(
      'AUTHORIZATION_PROVIDER_UNAVAILABLE',
    );
    expect(await codeOf(() => provider.consume('sha256:x', finalize))).toBe(
      'AUTHORIZATION_PROVIDER_UNAVAILABLE',
    );
    expect(await provider.health()).toMatchObject({
      status: 'fail',
      detail: 'replay-store-unavailable',
    });
    provider.close();
  });

  it('leaves the shared store open when it closes', async () => {
    const provider = onStore();
    const verification = await provider.verifyAndReserve(context(await validMandate()));

    provider.close();

    expect(await store.getAuthorizationHoldState(verification.reference)).toBe('reserved');
  });

  it('prefers the store to a configured file, which it never creates', async () => {
    const path = join(dir, 'replay.sqlite');
    const provider = onStore(store, { replay: { path } });

    await provider.verifyAndReserve(context(await validMandate()));

    expect(existsSync(path)).toBe(false);
    provider.close();
  });

  it('prefers an injected replayStore to the store', async () => {
    const replay = createAp2ReplayStore({ path: ':memory:' });
    const provider = createAp2AuthorizationProvider({
      config: config(),
      clock: fixedClock(),
      store,
      replayStore: replay,
    });

    const verification = await provider.verifyAndReserve(context(await validMandate()));

    expect(replay.stateOf(verification.reference)).toBe('reserved');
    expect(await store.getAuthorizationHoldState(verification.reference)).toBeUndefined();
    provider.close();
  });

  it('falls back to the file when the store has no hold methods, and needs one or the other', async () => {
    const path = join(dir, 'replay.sqlite');
    // A 2.5-shaped store: the hold group is absent
    const { reserveAuthorizationHold: _drop, ...bare } = store;
    const provider = onStore(bare, { replay: { path } });
    await provider.verifyAndReserve(context(await validMandate()));
    expect(existsSync(path)).toBe(true);
    provider.close();

    const { replay: _, ...noReplay } = config();
    expect(() =>
      createAp2AuthorizationProvider({ config: noReplay, clock: fixedClock(), store: bare }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
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
