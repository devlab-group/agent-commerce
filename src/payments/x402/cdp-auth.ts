/**
 * Signs the JWT that CDP's x402 facilitator requires on every request, in the
 * format `@coinbase/cdp-sdk` produces. A PEM EC P-256 key signs ES256; a base64
 * Ed25519 key (32-byte seed, then 32-byte public key) signs EdDSA. Each token
 * is valid for 120 seconds and names one method, host and path in `uris`.
 */
import { createPrivateKey, type KeyObject, randomBytes, sign } from 'node:crypto';
import { CommerceError } from '../../core';
import { CDP_FACILITATOR_URL } from './guardrails';

const TOKEN_LIFETIME_SECONDS = 120;

interface SigningKey {
  readonly alg: 'ES256' | 'EdDSA';
  readonly key: KeyObject;
}

/**
 * Create the SDK's path-keyed header factory. Invalid secrets throw
 * CONFIG_INVALID when the factory is called, failing health checks and
 * leaving payments without a verification verdict.
 */
export function createCdpAuthHeaders(
  apiKeyId: string,
  apiKeySecret: string,
  now: () => number = Date.now,
): () => Promise<Record<string, Record<string, string>>> {
  const signingKey = readKey(apiKeySecret);
  const { host, pathname } = new URL(CDP_FACILITATOR_URL);

  return async () => {
    if (!signingKey) {
      // Never echo the secret: it is the credential
      throw new CommerceError(
        'CONFIG_INVALID',
        'x402 provider: facilitator.auth.apiKeySecret is not a CDP API key secret. ' +
          'Use the PEM EC private key or the base64 Ed25519 key that CDP issued.',
      );
    }
    const issuedAt = Math.floor(now() / 1000);
    const header = (method: string, route: string) => ({
      Authorization: `Bearer ${signJwt(signingKey, apiKeyId, `${method} ${host}${pathname}/${route}`, issuedAt)}`,
    });
    return {
      verify: header('POST', 'verify'),
      settle: header('POST', 'settle'),
      supported: header('GET', 'supported'),
    };
  };
}

function readKey(secret: string): SigningKey | undefined {
  try {
    if (secret.includes('-----BEGIN')) {
      const key = createPrivateKey(secret);
      const p256 =
        key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
      return p256 ? { alg: 'ES256', key } : undefined;
    }
    const raw = Buffer.from(secret, 'base64');
    if (raw.length !== 64) return undefined;
    const key = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: raw.subarray(0, 32).toString('base64url'),
        x: raw.subarray(32).toString('base64url'),
      },
    });
    return { alg: 'EdDSA', key };
  } catch {
    return undefined;
  }
}

function signJwt(signingKey: SigningKey, apiKeyId: string, uri: string, issuedAt: number): string {
  const { alg, key } = signingKey;
  const header = { alg, kid: apiKeyId, typ: 'JWT', nonce: randomBytes(16).toString('hex') };
  const claims = {
    sub: apiKeyId,
    iss: 'cdp',
    uris: [uri],
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  };
  const input = `${base64url(header)}.${base64url(claims)}`;
  // JWS ES256 carries the raw 64-byte r||s, not DER
  const signature =
    alg === 'ES256'
      ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
      : sign(null, Buffer.from(input), key);
  return `${input}.${signature.toString('base64url')}`;
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
