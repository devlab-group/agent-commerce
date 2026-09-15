/**
 * Merchant-side helper: mint the checkout JWT a Checkout Mandate binds.
 *
 * The gateway only verifies. This is what a merchant runs in their own
 * process, with their own key, to produce the document the buyer approves. It
 * never calls the gateway and the gateway never calls it - the mirror of
 * `createPaymentProof`, which a buyer runs to produce a payment proof.
 *
 * It exists for `input_hash`, an RFC 8785 digest. A signer reaching for a
 * sorted-key `JSON.stringify` agrees on most inputs and disagrees on floats
 * and non-ASCII keys, and the mandate is then refused with a reason that does
 * not say which field disagreed.
 */
import { importPKCS8, type JWK, SignJWT } from 'jose';
import {
  AP2_CHECKOUT_PROFILE,
  AP2_JWK_CURVE,
  AP2_KEY_TYPE,
  AP2_SIGNING_ALGORITHM,
} from './constants.js';
import { computeInputHash } from './profile.js';

/**
 * A private ES256 key: either a private JWK (the pair of the public one in the
 * gateway's `checkoutIssuers`) or a PKCS#8 PEM, as `openssl` emits it.
 */
export type Ap2SigningKey = Readonly<Record<string, unknown>> | string;

export interface CreateCheckoutJwtOptions {
  readonly privateKey: Ap2SigningKey;
  /** Must match a `kid` configured under the gateway's `checkoutIssuers` */
  readonly kid: string;
  /** Must match that issuer's configured `issuer` */
  readonly issuer: string;
  /** Must match that issuer's configured `audience` */
  readonly audience: string;

  readonly resourceId: string;
  /**
   * The resource input this purchase is for, exactly as the buyer will send
   * it: no reserved fields, no request id, no transport metadata.
   */
  readonly input: unknown;

  /**
   * Decimal string, never a number, and compared as a string: `0.10` and `0.1`
   * are different mandates. Take it from your own catalogue rather than from
   * whatever the agent asked for.
   */
  readonly amount: string;
  readonly currency: string;
  /** The rail that will settle, e.g. `x402` */
  readonly paymentMethod: string;

  /**
   * Settlement coordinates. Required whenever the gateway's requirement names
   * them, which under x402 is always. A mandate silent about the chain will
   * not unlock a settlement on one.
   */
  readonly destination?: string;
  readonly network?: string;
  readonly asset?: string;

  /** Defaults to a random UUID. Recorded on the receipt and used for replay defence */
  readonly jwtId?: string;
  /** Defaults to 900: a human approval sits inside this window */
  readonly expiresInSeconds?: number;
  /** Injectable so a test need not move the wall clock */
  readonly now?: Date;
}

const DEFAULT_EXPIRES_IN_SECONDS = 900;

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `createCheckoutJwt: ${field} must be a non-empty string, received ${describe(value)}`,
    );
  }
  return value;
}

function describe(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

/**
 * Every rejection here is a mistake that would otherwise surface as an opaque
 * verification failure much later: the public half of the pair, the wrong key
 * type, or a PEM that is not PKCS#8.
 */
async function resolveKey(
  key: Ap2SigningKey,
): Promise<JWK | Awaited<ReturnType<typeof importPKCS8>>> {
  if (typeof key === 'string') {
    if (!key.includes('BEGIN PRIVATE KEY')) {
      throw new TypeError(
        'createCheckoutJwt: a string privateKey must be a PKCS#8 PEM beginning "-----BEGIN PRIVATE KEY-----"',
      );
    }
    return importPKCS8(key, AP2_SIGNING_ALGORITHM);
  }
  if (typeof key !== 'object' || key === null) {
    throw new TypeError('createCheckoutJwt: privateKey must be a private JWK or a PKCS#8 PEM');
  }
  if (key['d'] === undefined) {
    throw new TypeError(
      'createCheckoutJwt: privateKey is a public JWK (no "d"). Use the private half of the pair whose public key is configured under checkoutIssuers',
    );
  }
  if (key['kty'] !== AP2_KEY_TYPE || key['crv'] !== AP2_JWK_CURVE) {
    throw new TypeError(
      `createCheckoutJwt: privateKey must be ${AP2_KEY_TYPE}/${AP2_JWK_CURVE}, the pair ${AP2_SIGNING_ALGORITHM} implies`,
    );
  }
  return key as JWK;
}

/**
 * Returns the compact JWT to hand to the agent, which wraps it in the Checkout
 * Mandate the buyer signs.
 */
export async function createCheckoutJwt(options: CreateCheckoutJwtOptions): Promise<string> {
  const kid = requireText(options.kid, 'kid');
  const issuer = requireText(options.issuer, 'issuer');
  const audience = requireText(options.audience, 'audience');
  const resourceId = requireText(options.resourceId, 'resourceId');
  const currency = requireText(options.currency, 'currency');
  const paymentMethod = requireText(options.paymentMethod, 'paymentMethod');

  if (typeof options.amount === 'number') {
    throw new TypeError(
      'createCheckoutJwt: amount must be a decimal string, not a number. It is compared as a string, so 0.1 and "0.10" are different mandates',
    );
  }
  const amount = requireText(options.amount, 'amount');

  const key = await resolveKey(options.privateKey);
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const expiresIn = options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new TypeError('createCheckoutJwt: expiresInSeconds must be a positive whole number');
  }

  const agentCommerce: Record<string, string> = {
    profile: AP2_CHECKOUT_PROFILE,
    resource_id: resourceId,
    input_hash: await computeInputHash(options.input),
    amount,
    currency,
    payment_method: paymentMethod,
    ...(options.destination !== undefined ? { destination: options.destination } : {}),
    ...(options.network !== undefined ? { network: options.network } : {}),
    ...(options.asset !== undefined ? { asset: options.asset } : {}),
  };

  return new SignJWT({ agent_commerce: agentCommerce })
    .setProtectedHeader({ alg: AP2_SIGNING_ALGORITHM, kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .setJti(options.jwtId ?? crypto.randomUUID())
    .sign(key);
}
