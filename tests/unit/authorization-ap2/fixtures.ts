/**
 * Builds AP2 Direct Checkout Mandate presentations for the verifier tests.
 *
 * PROVENANCE: these are NOT golden vectors from the AP2 repository. They are
 * built here to the v0.2.0 closed Checkout Mandate shape, with real ES256 keys
 * and real signatures from `jose`. So they show the verifier enforces the
 * rules as this repository reads them; they do not show interoperability with
 * a mandate the reference implementation minted. Upstream vectors, with the
 * commit recorded, belong here before anyone calls this stable.
 *
 * Keys are generated per run and never written down.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_CHECKOUT_PROFILE,
} from '../../../src/authorization/ap2/constants.js';
import type { Ap2TrustedIssuer } from '../../../src/authorization/ap2/types.js';

export const MANDATE_ISSUER = 'https://trusted-surface.example';
export const MANDATE_AUDIENCE = 'merchant.example';
export const CHECKOUT_ISSUER = 'https://merchant.example';
export const CHECKOUT_AUDIENCE = 'agent-commerce';

/** Fixed instant every fixture is minted against, so nothing races a real clock */
export const NOW = new Date('2026-09-14T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

// `CryptoKey` is a DOM type and server code here does not load the DOM lib
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface SigningIdentity {
  readonly kid: string;
  readonly privateKey: PrivateKey;
  readonly publicJwk: Readonly<Record<string, string>>;
}

async function identity(kid: string): Promise<SigningIdentity> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(publicKey)) as Record<string, string>;
  return {
    kid,
    privateKey,
    // Only the four members the config loader accepts. `exportJWK` also emits
    // `key_ops`/`ext` on some runtimes, which config rightly refuses.
    publicJwk: {
      kty: jwk['kty'] as string,
      crv: jwk['crv'] as string,
      x: jwk['x'] as string,
      y: jwk['y'] as string,
    },
  };
}

export function trustedIssuer(
  issuer: string,
  audience: string,
  signer: SigningIdentity,
): Ap2TrustedIssuer {
  return { issuer, audience, keys: [{ kid: signer.kid, jwk: signer.publicJwk }] };
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    'base64url',
  );
}

async function sha256(input: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/** base64url(SHA-256(utf8)), the digest AP2 uses everywhere */
export const sha256Base64url = sha256;

/** One SD-JWT disclosure for an object property: `[salt, name, value]` */
export function disclosure(salt: string, name: string, value: unknown): string {
  return Buffer.from(JSON.stringify([salt, name, value]), 'utf8').toString('base64url');
}

/** The Agent Commerce checkout profile payload, as the plan specifies it */
export function checkoutPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: CHECKOUT_ISSUER,
    aud: CHECKOUT_AUDIENCE,
    iat: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 300,
    jti: 'checkout_01KTEST',
    agent_commerce: {
      profile: AP2_CHECKOUT_PROFILE,
      resource_id: 'market_report',
      input_hash: 'PLACEHOLDER_UNTIL_PURCHASE_BINDING',
      amount: '0.01',
      currency: 'USDC',
      payment_method: 'x402',
    },
    ...overrides,
  };
}

export async function signCheckoutJwt(
  signer: SigningIdentity,
  payload: Record<string, unknown> = checkoutPayload(),
  header: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: signer.kid, ...header })
    .sign(signer.privateKey);
}

export interface MandateOptions {
  /** Replaces the compact checkout JWT after `checkout_hash` has been computed */
  readonly checkoutJwtOverride?: string;
  readonly payloadOverrides?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
  /** Extra disclosure strings appended to the presentation */
  readonly extraDisclosures?: readonly string[];
  /** Extra claims committed to in `_sd`, disclosable independently */
  readonly disclosable?: Readonly<Record<string, unknown>>;
  /** Which of {@link MandateOptions.disclosable} to actually present */
  readonly present?: readonly string[];
  /** Omit the disclosure that carries the checkout JWT */
  readonly withholdCheckoutDisclosure?: boolean;
}

/**
 * A signed mandate and its disclosures, kept apart. ES256 uses a fresh nonce
 * per signature, so a test needing ONE mandate presented two ways must mint
 * once and vary the disclosures afterwards.
 */
export interface MandateParts {
  readonly signedToken: string;
  readonly checkoutDisclosure: string;
  /** Encoded disclosure per optional claim name */
  readonly optional: Readonly<Record<string, string>>;
}

/** Joins a signed token and a chosen set of disclosures into a presentation */
export function assemblePresentation(signedToken: string, disclosures: readonly string[]): string {
  return `${signedToken}~${disclosures.map((d) => `${d}~`).join('')}`;
}

/**
 * Mints a closed Checkout Mandate presentation carrying `checkout_jwt` as a
 * selectively disclosed claim, which is the shape a Direct presentation takes
 */
export async function mintMandate(
  mandateSigner: SigningIdentity,
  checkoutJwt: string,
  options: MandateOptions = {},
): Promise<string> {
  const parts = await mintMandateParts(mandateSigner, checkoutJwt, options);
  const presented = [
    ...(options.withholdCheckoutDisclosure ? [] : [parts.checkoutDisclosure]),
    ...Object.entries(parts.optional)
      .filter(([name]) => options.present === undefined || options.present.includes(name))
      .map(([, encoded]) => encoded),
    ...(options.extraDisclosures ?? []),
  ];
  return assemblePresentation(parts.signedToken, presented);
}

/** The same mandate, handed back unassembled */
export async function mintMandateParts(
  mandateSigner: SigningIdentity,
  checkoutJwt: string,
  options: MandateOptions = {},
): Promise<MandateParts> {
  const checkoutDisclosure = disclosure('salt-checkout', 'checkout_jwt', checkoutJwt);
  const optional = Object.entries(options.disclosable ?? {}).map(([name, value]) => ({
    name,
    encoded: disclosure(`salt-${name}`, name, value),
  }));
  const optionalDigests = await Promise.all(optional.map((entry) => sha256(entry.encoded)));
  const payload: Record<string, unknown> = {
    vct: AP2_CHECKOUT_MANDATE_VCT,
    iss: MANDATE_ISSUER,
    aud: MANDATE_AUDIENCE,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
    checkout_hash: await sha256(checkoutJwt),
    _sd_alg: 'sha-256',
    _sd: [await sha256(checkoutDisclosure), ...optionalDigests],
    ...options.payloadOverrides,
  };

  const jws = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: mandateSigner.kid, ...options.header })
    .sign(mandateSigner.privateKey);

  return {
    signedToken: jws,
    checkoutDisclosure:
      options.checkoutJwtOverride !== undefined
        ? disclosure('salt-checkout', 'checkout_jwt', options.checkoutJwtOverride)
        : checkoutDisclosure,
    optional: Object.fromEntries(optional.map((entry) => [entry.name, entry.encoded])),
  };
}

export interface Party {
  readonly mandateSigner: SigningIdentity;
  readonly checkoutSigner: SigningIdentity;
  readonly stranger: SigningIdentity;
  readonly mandateIssuers: readonly Ap2TrustedIssuer[];
  readonly checkoutIssuers: readonly Ap2TrustedIssuer[];
}

/** Key generation is the slow part, so a suite builds this once */
export async function createParties(): Promise<Party> {
  const [mandateSigner, checkoutSigner, stranger] = await Promise.all([
    identity('mandate-key-2026-01'),
    identity('checkout-key-2026-01'),
    identity('stranger-key'),
  ]);
  return {
    mandateSigner,
    checkoutSigner,
    stranger,
    mandateIssuers: [trustedIssuer(MANDATE_ISSUER, MANDATE_AUDIENCE, mandateSigner)],
    checkoutIssuers: [trustedIssuer(CHECKOUT_ISSUER, CHECKOUT_AUDIENCE, checkoutSigner)],
  };
}

/** A `Clock` pinned to {@link NOW}, or to an offset from it */
export function fixedClock(at: Date = NOW) {
  return {
    now: () => at,
    nowIso: () => at.toISOString(),
    monotonicMs: () => 0,
  };
}
