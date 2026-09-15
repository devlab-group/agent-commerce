/**
 * AP2 trust and resource policy, validated at load.
 *
 * A trust policy that cannot be enforced has to fail at startup, not at the
 * first purchase. The two shapes worth catching are an AP2-required resource
 * that settles unprotected because the provider was off, and a verification
 * key that turns out to be malformed only once a buyer presents a valid
 * mandate.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/schema.js';
import { isCommerceError } from '../../../src/core/index.js';
import { validRawConfig } from './fixtures.js';

/**
 * The P-256 public key from RFC 7515 appendix A.3.1. A published example, so
 * it is a genuine point on the curve with no private half anyone has to keep.
 */
const PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

function issuer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: 'https://trusted-surface.example',
    audience: 'merchant.example',
    keys: [{ kid: 'key-2026-01', jwk: { ...PUBLIC_JWK } }],
    ...overrides,
  };
}

function withAp2(
  ap2: Record<string, unknown> = {},
  resourceAuthorization?: Record<string, unknown>,
): Record<string, unknown> {
  const raw = validRawConfig();
  raw['authorization'] = {
    ap2: {
      enabled: true,
      replay: { path: './data/ap2-authorizations.sqlite' },
      trust: {
        mandateIssuers: [issuer()],
        checkoutIssuers: [
          issuer({ issuer: 'https://merchant.example', audience: 'agent-commerce' }),
        ],
      },
      ...ap2,
    },
  };
  if (resourceAuthorization !== undefined) {
    (raw['resources'] as Record<string, Record<string, unknown>>)['market_report'] = {
      ...(raw['resources'] as Record<string, Record<string, unknown>>)['market_report'],
      authorization: resourceAuthorization,
    };
  }
  return raw;
}

function messageFor(raw: Record<string, unknown>): string {
  try {
    parseConfig(raw, {});
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    return (error as Error).message;
  }
  return expect.unreachable('expected config to be rejected') as never;
}

function expectRejected(raw: Record<string, unknown>): string {
  const message = messageFor(raw);
  try {
    parseConfig(raw, {});
  } catch (error) {
    if (isCommerceError(error)) expect(error.code).toBe('CONFIG_INVALID');
  }
  return message;
}

describe('configs without AP2', () => {
  it('parse unchanged and report no authorization block at all', () => {
    const config = parseConfig(validRawConfig(), {});
    expect(config.authorization).toBeUndefined();
    expect(config.resources.every((r) => r.authorization === undefined)).toBe(true);
  });
});

describe('authorization.ap2 trust policy', () => {
  it('normalises an enabled block, defaulting the version, mode and skew', () => {
    const config = parseConfig(withAp2(), {});
    const ap2 = config.authorization?.ap2;
    expect(ap2).toMatchObject({
      enabled: true,
      specVersion: '0.2.0',
      mode: 'direct',
      clockSkewSeconds: 60,
      replay: { path: './data/ap2-authorizations.sqlite' },
    });
  });

  it('keeps a disabled block as a placeholder without demanding a trust policy', () => {
    const raw = validRawConfig();
    raw['authorization'] = { ap2: { enabled: false } };
    expect(parseConfig(raw, {}).authorization?.ap2).toEqual({ enabled: false });
  });

  it('carries both issuer lists through with their keys', () => {
    const ap2 = parseConfig(withAp2(), {}).authorization?.ap2;
    if (ap2?.enabled !== true) return expect.unreachable();
    expect(ap2.trust.mandateIssuers[0]).toEqual({
      issuer: 'https://trusted-surface.example',
      audience: 'merchant.example',
      keys: [{ kid: 'key-2026-01', jwk: PUBLIC_JWK }],
    });
    expect(ap2.trust.checkoutIssuers[0]?.audience).toBe('agent-commerce');
  });

  it.each([
    ['an unsupported spec version', { specVersion: '0.1.0' }, '0.2.0'],
    ['autonomous mode', { mode: 'autonomous' }, 'direct'],
  ])('rejects %s', (_label, override, hint) => {
    expect(expectRejected(withAp2(override))).toContain(hint);
  });

  it('rejects an enabled block with no replay store', () => {
    const raw = withAp2();
    const ap2 = (raw['authorization'] as { ap2: Record<string, unknown> }).ap2;
    delete ap2['replay'];
    expect(expectRejected(raw)).toContain('replay');
  });

  it.each([
    ['no mandate issuers', 'mandateIssuers'],
    ['no checkout issuers', 'checkoutIssuers'],
  ])('rejects a trust policy with %s', (_label, list) => {
    const raw = withAp2();
    const trust = (raw['authorization'] as { ap2: { trust: Record<string, unknown> } }).ap2.trust;
    trust[list] = [];
    expect(expectRejected(raw)).toContain(list);
  });

  it('rejects the same issuer listed twice, pointing at key rotation instead', () => {
    const message = expectRejected(
      withAp2({ trust: { mandateIssuers: [issuer(), issuer()], checkoutIssuers: [issuer()] } }),
    );
    expect(message).toContain('listed twice');
    expect(message).toContain('rotation');
  });

  it('rejects two keys sharing a kid, which would make signature selection undefined', () => {
    const duplicate = issuer({
      keys: [
        { kid: 'key-2026-01', jwk: { ...PUBLIC_JWK } },
        { kid: 'key-2026-01', jwk: { ...PUBLIC_JWK } },
      ],
    });
    expect(
      expectRejected(
        withAp2({ trust: { mandateIssuers: [duplicate], checkoutIssuers: [issuer()] } }),
      ),
    ).toContain('listed twice');
  });

  it('accepts an overlapping old and new key under one issuer, which is how rotation works', () => {
    const rotating = issuer({
      keys: [
        { kid: 'key-2025-07', jwk: { ...PUBLIC_JWK } },
        { kid: 'key-2026-01', jwk: { ...PUBLIC_JWK } },
      ],
    });
    const ap2 = parseConfig(
      withAp2({ trust: { mandateIssuers: [rotating], checkoutIssuers: [issuer()] } }),
      {},
    ).authorization?.ap2;
    if (ap2?.enabled !== true) return expect.unreachable();
    expect(ap2.trust.mandateIssuers[0]?.keys.map((k) => k.kid)).toEqual([
      'key-2025-07',
      'key-2026-01',
    ]);
  });

  it('rejects an issuer with no audience', () => {
    const raw = withAp2();
    const trust = (
      raw['authorization'] as { ap2: { trust: { mandateIssuers: [Record<string, unknown>] } } }
    ).ap2.trust;
    delete trust.mandateIssuers[0]['audience'];
    expect(expectRejected(raw)).toContain('audience');
  });

  it('clamps nothing silently: a skew past the ceiling is refused', () => {
    expect(expectRejected(withAp2({ clockSkewSeconds: 3600 }))).toContain('300');
  });

  it('accepts a skew inside the ceiling', () => {
    const ap2 = parseConfig(withAp2({ clockSkewSeconds: 120 }), {}).authorization?.ap2;
    if (ap2?.enabled !== true) return expect.unreachable();
    expect(ap2.clockSkewSeconds).toBe(120);
  });
});

describe('verification key validation', () => {
  function withJwk(jwk: Record<string, unknown>): Record<string, unknown> {
    return withAp2({
      trust: {
        mandateIssuers: [issuer({ keys: [{ kid: 'key-2026-01', jwk }] })],
        checkoutIssuers: [issuer()],
      },
    });
  }

  it('rejects private key material and says to rotate the key', () => {
    const message = expectRejected(withJwk({ ...PUBLIC_JWK, d: 'not-a-real-private-scalar' }));
    expect(message).toContain('private key material');
    expect(message).toContain('rotate');
  });

  it.each([
    ['a URL-valued member', { ...PUBLIC_JWK, x5u: 'https://attacker.example/keys.json' }],
    ['a smuggled jku', { ...PUBLIC_JWK, jku: 'https://attacker.example/jwks' }],
  ])('refuses %s rather than ever fetching it', (_label, jwk) => {
    expect(expectRejected(withJwk(jwk))).toContain('never fetched');
  });

  it.each([
    ['an RSA key', { ...PUBLIC_JWK, kty: 'RSA' }],
    ['a symmetric key', { ...PUBLIC_JWK, kty: 'oct' }],
    ['the wrong curve', { ...PUBLIC_JWK, crv: 'P-384' }],
    ['a non-ES256 alg', { ...PUBLIC_JWK, alg: 'ES384' }],
  ])('rejects %s', (_label, jwk) => {
    expectRejected(withJwk(jwk));
  });

  it.each([
    ['a truncated coordinate', { ...PUBLIC_JWK, x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8' }],
    [
      'standard base64 rather than base64url',
      { ...PUBLIC_JWK, y: `x/FEzRu9m36HLN+tue659LNpXW6pCyStikYjKIWI5a0` },
    ],
    ['a missing coordinate', { kty: 'EC', crv: 'P-256', x: PUBLIC_JWK.x }],
    ['a non-string coordinate', { ...PUBLIC_JWK, y: 42 }],
  ])('rejects %s', (_label, jwk) => {
    expectRejected(withJwk(jwk as Record<string, unknown>));
  });

  it('rejects a key whose own kid disagrees with the configured one', () => {
    expect(expectRejected(withJwk({ ...PUBLIC_JWK, kid: 'something-else' }))).toContain(
      'disagrees',
    );
  });

  it('rejects an encryption key offered for verification', () => {
    expect(expectRejected(withJwk({ ...PUBLIC_JWK, use: 'enc' }))).toContain('sig');
  });

  it('accepts the optional members it does allow', () => {
    const config = parseConfig(
      withJwk({ ...PUBLIC_JWK, kid: 'key-2026-01', alg: 'ES256', use: 'sig' }),
      {},
    );
    const ap2 = config.authorization?.ap2;
    if (ap2?.enabled !== true) return expect.unreachable();
    expect(ap2.trust.mandateIssuers[0]?.keys[0]?.jwk).toMatchObject({ alg: 'ES256', use: 'sig' });
  });
});

describe('replay store isolation', () => {
  it('rejects a replay path shared with the receipt store', () => {
    expect(expectRejected(withAp2({ replay: { path: './data/receipts.sqlite' } }))).toContain(
      'storage.receipts.path',
    );
  });

  it('rejects a replay path shared with the ACP idempotency store', () => {
    const raw = withAp2({ replay: { path: './data/acp.sqlite' } });
    const protocols = raw['protocols'] as Record<string, unknown>;
    protocols['acp'] = {
      enabled: true,
      mountPath: '/acp',
      auth: { type: 'bearer', token: 'tok' },
      idempotency: { path: './data/acp.sqlite' },
      checkout: {
        operations: {
          createCheckoutSession: 'c1',
          updateCheckoutSession: 'c2',
          getCheckoutSession: 'c3',
          completeCheckoutSession: 'c4',
          cancelCheckoutSession: 'c5',
        },
      },
    };
    expect(expectRejected(raw)).toContain('protocols.acp.idempotency.path');
  });

  it('allows two in-memory stores, which are separate databases', () => {
    const raw = withAp2({ replay: { path: ':memory:' } });
    (raw['storage'] as { receipts: { path: string } }).receipts.path = ':memory:';
    expect(parseConfig(raw, {}).authorization?.ap2.enabled).toBe(true);
  });
});

describe('resource authorization policy', () => {
  it('attaches the requirement to the canonical resource', () => {
    const config = parseConfig(withAp2({}, { required: ['ap2'] }), {});
    const resource = config.resources.find((r) => r.id === 'market_report');
    expect(resource?.authorization).toEqual({ required: ['ap2'] });
    // And leaves every other resource untouched.
    expect(config.resources.find((r) => r.id === 'weather_basic')?.authorization).toBeUndefined();
  });

  it('rejects a required method the gateway does not implement', () => {
    expect(expectRejected(withAp2({}, { required: ['ap3'] }))).toContain('ap3');
  });

  it('rejects the same method listed twice', () => {
    expect(expectRejected(withAp2({}, { required: ['ap2', 'ap2'] }))).toContain('twice');
  });

  it('rejects an empty requirement list rather than reading it as "none"', () => {
    expectRejected(withAp2({}, { required: [] }));
  });

  it('rejects a resource requiring AP2 while the provider is disabled', () => {
    const raw = withAp2({}, { required: ['ap2'] });
    (raw['authorization'] as { ap2: Record<string, unknown> }).ap2['enabled'] = false;
    expect(expectRejected(raw)).toContain('not configured or not enabled');
  });

  it('rejects a resource requiring AP2 with no authorization block configured at all', () => {
    const raw = validRawConfig();
    (raw['resources'] as Record<string, Record<string, unknown>>)['market_report'] = {
      ...(raw['resources'] as Record<string, Record<string, unknown>>)['market_report'],
      authorization: { required: ['ap2'] },
    };
    expect(expectRejected(raw)).toContain('not configured or not enabled');
  });

  it('rejects AP2 required on a free resource', () => {
    const raw = withAp2();
    (raw['resources'] as Record<string, Record<string, unknown>>)['weather_basic'] = {
      ...(raw['resources'] as Record<string, Record<string, unknown>>)['weather_basic'],
      authorization: { required: ['ap2'] },
    };
    const message = expectRejected(raw);
    expect(message).toContain('never replaces payment');
  });
});
