// AP2 mandate verification settings and each resource's authorization requirement
import type { z } from 'zod';
import {
  AP2_DEFAULT_CLOCK_SKEW_SECONDS,
  AP2_JWK_COORDINATE_BYTES,
  AP2_JWK_CURVE,
  AP2_JWK_MEMBERS,
  AP2_KEY_TYPE,
  AP2_MAX_CLOCK_SKEW_SECONDS,
  AP2_MODES,
  AP2_SIGNING_ALGORITHM,
  AP2_SPEC_VERSION,
} from '../../authorization/ap2/constants';
import type {
  Ap2AuthorizationConfig,
  Ap2Mode,
  Ap2TrustedIssuer,
} from '../../authorization/ap2/types';
import {
  type AuthorizationMethodName,
  CommerceError,
  type CommerceResource,
  type Pricing,
} from '../../core';
import type { Ap2IssuerSchema, RawConfig, RawResourceEntry } from './raw';
import type { AcpProtocolConfig } from './types';
import { toBoolean, toNumber } from './values';

const SUPPORTED_AUTHORIZATION_METHODS: ReadonlySet<string> = new Set(['ap2']);

type RawAp2 = NonNullable<NonNullable<RawConfig['authorization']>['ap2']>;

function ap2Invalid(
  path: string,
  message: string,
  extra: Record<string, unknown> = {},
): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path, ...extra } });
}

export function normalizeAp2(raw: RawAp2 | undefined): Ap2AuthorizationConfig | undefined {
  if (raw === undefined) return undefined;
  if (!toBoolean(raw.enabled, 'authorization.ap2.enabled')) return { enabled: false };

  const specVersion = raw.specVersion ?? AP2_SPEC_VERSION;
  if (specVersion !== AP2_SPEC_VERSION) {
    throw ap2Invalid(
      'authorization.ap2.specVersion',
      `authorization.ap2.specVersion "${specVersion}" is not supported - this gateway verifies against the tagged AP2 release ${AP2_SPEC_VERSION} only`,
    );
  }

  const mode = raw.mode ?? AP2_MODES[0];
  if (!(AP2_MODES as readonly string[]).includes(mode)) {
    throw ap2Invalid(
      'authorization.ap2.mode',
      `authorization.ap2.mode "${mode}" is not supported. Supported: ${AP2_MODES.join(', ')}. Autonomous mode needs open mandates, agent key binding and constraint evaluation, none of which this release implements.`,
    );
  }

  if (raw.replay === undefined) {
    throw ap2Invalid(
      'authorization.ap2.replay',
      'authorization.ap2.replay is required when AP2 is enabled - it names the SQLite file recording which mandates have been spent, and without it a verified mandate could authorize a second settlement',
    );
  }

  const mandateIssuers = normalizeIssuers(
    raw.trust?.mandateIssuers,
    'authorization.ap2.trust.mandateIssuers',
  );
  const checkoutIssuers = normalizeIssuers(
    raw.trust?.checkoutIssuers,
    'authorization.ap2.trust.checkoutIssuers',
  );

  return {
    enabled: true,
    specVersion: AP2_SPEC_VERSION,
    mode: mode as Ap2Mode,
    trust: { mandateIssuers, checkoutIssuers },
    clockSkewSeconds: toNumber(
      raw.clockSkewSeconds ?? AP2_DEFAULT_CLOCK_SKEW_SECONDS,
      'authorization.ap2.clockSkewSeconds',
      { min: 0, max: AP2_MAX_CLOCK_SKEW_SECONDS },
    ),
    requireMandateAudience: toBoolean(
      raw.requireMandateAudience ?? false,
      'authorization.ap2.requireMandateAudience',
    ),
    requireMandateExpiry: toBoolean(
      raw.requireMandateExpiry ?? false,
      'authorization.ap2.requireMandateExpiry',
    ),
    replay: { path: raw.replay.path },
  };
}

// Both issuer lists must be non-empty when AP2 is on: verification checks the
// issuer's signature over the Checkout Mandate and the merchant's over the
// checkout JWT it binds. An empty list would fail every mandate at request
// time instead of at load.
function normalizeIssuers(
  raw: readonly z.infer<typeof Ap2IssuerSchema>[] | undefined,
  path: string,
): readonly Ap2TrustedIssuer[] {
  if (raw === undefined || raw.length === 0) {
    throw ap2Invalid(
      path,
      `${path} is required when AP2 is enabled and must name at least one issuer - trust is operator-configured and static, so an empty list means no mandate can ever verify`,
    );
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const entryPath = `${path}.${index}`;
    if (seen.has(entry.issuer)) {
      throw ap2Invalid(
        `${entryPath}.issuer`,
        `${entryPath}.issuer "${entry.issuer}" is listed twice - key lookup resolves by issuer, so a second entry for the same one is silently unreachable. Merge the keys into one entry instead (which is also how a rotation overlaps an old and a new key).`,
        { issuer: entry.issuer },
      );
    }
    seen.add(entry.issuer);

    const kids = new Set<string>();
    const keys = entry.keys.map((key, keyIndex) => {
      const keyPath = `${entryPath}.keys.${keyIndex}`;
      if (kids.has(key.kid)) {
        throw ap2Invalid(
          `${keyPath}.kid`,
          `${keyPath}.kid "${key.kid}" is listed twice for issuer "${entry.issuer}" - a kid selects exactly one key, so which of the two verifies a signature would be undefined`,
          { issuer: entry.issuer, kid: key.kid },
        );
      }
      kids.add(key.kid);
      return { kid: key.kid, jwk: validateJwk(key.jwk, key.kid, keyPath) };
    });

    return { issuer: entry.issuer, audience: entry.audience, keys };
  });
}

// Accepts only a public P-256 key. Every member is checked at load rather than
// by the JOSE library at the first purchase, so a bad key fails the deploy
// instead of a buyer's valid mandate.
function validateJwk(
  jwk: Record<string, unknown>,
  kid: string,
  path: string,
): Readonly<Record<string, string>> {
  const fail = (detail: string): never => {
    throw ap2Invalid(`${path}.jwk`, `${path}.jwk (kid "${kid}") ${detail}`, { kid });
  };

  for (const member of Object.keys(jwk)) {
    if ((AP2_JWK_MEMBERS as readonly string[]).includes(member)) continue;
    // `d` (an EC private scalar) or `k` (a symmetric key) means signing
    // material was pasted where only verification material belongs, which the
    // operator needs to hear about specifically
    if (member === 'd' || member === 'k') {
      fail(
        `carries private key material ("${member}"). The gateway verifies signatures and never produces them; publish only the public half. Treat the pasted key as compromised and rotate it.`,
      );
    }
    fail(
      `has unsupported member "${member}". Allowed: ${AP2_JWK_MEMBERS.join(', ')}. Members naming a URL are refused on purpose - keys are configured inline and never fetched.`,
    );
  }

  const value = (member: string): string => {
    const raw = jwk[member];
    if (typeof raw !== 'string' || raw.length === 0) {
      fail(`must give "${member}" as a non-empty string`);
    }
    return raw as string;
  };

  if (value('kty') !== AP2_KEY_TYPE) {
    fail(
      `must have kty "${AP2_KEY_TYPE}" (got "${value('kty')}") - ${AP2_SIGNING_ALGORITHM} is the only accepted algorithm`,
    );
  }
  if (value('crv') !== AP2_JWK_CURVE) {
    fail(
      `must be on curve "${AP2_JWK_CURVE}" (got "${value('crv')}") - ${AP2_SIGNING_ALGORITHM} is the only accepted algorithm`,
    );
  }
  for (const coordinate of ['x', 'y'] as const) {
    const encoded = value(coordinate);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      fail(`coordinate "${coordinate}" is not base64url (no padding, no "+" or "/")`);
    }
    if (Buffer.from(encoded, 'base64url').length !== AP2_JWK_COORDINATE_BYTES) {
      fail(
        `coordinate "${coordinate}" decodes to ${Buffer.from(encoded, 'base64url').length} bytes; a ${AP2_JWK_CURVE} coordinate is ${AP2_JWK_COORDINATE_BYTES}`,
      );
    }
  }
  if (jwk['alg'] !== undefined && value('alg') !== AP2_SIGNING_ALGORITHM) {
    fail(`declares alg "${value('alg')}"; only ${AP2_SIGNING_ALGORITHM} is accepted`);
  }
  if (jwk['use'] !== undefined && value('use') !== 'sig') {
    fail(`declares use "${value('use')}"; a verification key must be "sig"`);
  }
  if (jwk['kid'] !== undefined && value('kid') !== kid) {
    fail(`declares kid "${value('kid')}", which disagrees with the configured kid "${kid}"`);
  }

  const normalized: Record<string, string> = {};
  for (const member of AP2_JWK_MEMBERS) {
    if (jwk[member] !== undefined) normalized[member] = value(member);
  }
  return normalized;
}

// The AP2 replay store gets its own SQLite file. Reserved mandates, payment
// attempts and ACP idempotency records have different schemas and retention
// rules, and a shared file means a migration conflict at startup or a shared
// write lock on the settlement path.
export function validateReplayStoreIsolated(
  replayPath: string,
  receiptsPath: string,
  acp: AcpProtocolConfig,
): void {
  // Every `:memory:` handle is its own private database, so equal strings do
  // not collide
  if (replayPath === ':memory:') return;

  const others: [string, string][] = [['storage.receipts.path', receiptsPath]];
  if (acp.enabled) others.push(['protocols.acp.idempotency.path', acp.idempotency.path]);

  for (const [otherPath, other] of others) {
    if (replayPath !== other) continue;
    throw ap2Invalid(
      'authorization.ap2.replay.path',
      `authorization.ap2.replay.path is the same file as ${otherPath} ("${replayPath}") - the AP2 replay store keeps its own schema and must not share a database with another store`,
    );
  }
}

// Resolves a resource's `authorization.required` list against the configured
// provider. A requirement that cannot be enforced is refused: the resource
// would look protected in config and settle unprotected.
export function normalizeResourceAuthorization(
  id: string,
  entry: RawResourceEntry,
  pricing: Pricing,
  ap2: Ap2AuthorizationConfig | undefined,
): CommerceResource['authorization'] | undefined {
  const required = entry.authorization?.required;
  if (required === undefined) return undefined;

  const path = `resources.${id}.authorization.required`;
  const methods: AuthorizationMethodName[] = [];
  for (const method of required) {
    if (!SUPPORTED_AUTHORIZATION_METHODS.has(method)) {
      throw ap2Invalid(
        path,
        `Resource "${id}" requires unsupported authorization method "${method}". Supported: ${[...SUPPORTED_AUTHORIZATION_METHODS].join(', ')}.`,
        { resourceId: id, method },
      );
    }
    if (methods.includes(method as AuthorizationMethodName)) {
      throw ap2Invalid(path, `Resource "${id}" lists authorization method "${method}" twice`, {
        resourceId: id,
        method,
      });
    }
    if (method === 'ap2' && (ap2 === undefined || !ap2.enabled)) {
      throw ap2Invalid(
        path,
        `Resource "${id}" requires authorization method "ap2", which is not configured or not enabled under authorization.ap2`,
        { resourceId: id, method },
      );
    }
    methods.push(method as AuthorizationMethodName);
  }

  // A mandate binds an exact amount and currency and never unlocks a resource
  // by itself, so it only means something on a fixed-price resource
  if (pricing.type !== 'fixed') {
    throw ap2Invalid(
      path,
      `Resource "${id}" requires authorization but its pricing is "${pricing.type}" - authorization proves a purchase was approved and never replaces payment, so it applies to fixed-price paid resources only in this release`,
      { resourceId: id },
    );
  }

  return { required: methods };
}
