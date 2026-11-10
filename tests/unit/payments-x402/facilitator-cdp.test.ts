/**
 * CDP API-key JWTs in `@coinbase/cdp-sdk`'s format. An invalid secret fails
 * construction with CONFIG_INVALID, which stops `start` before it listens.
 */

import { generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCommerceError } from '../../../src/core';
import { createCdpAuthHeaders } from '../../../src/payments/x402/cdp-auth';
import { createRemoteFacilitatorBinding } from '../../../src/payments/x402/facilitator';

// Count signatures to verify that unread routes stay unsigned
const signatures = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    sign: (...args: Parameters<typeof actual.sign>) => {
      signatures.count += 1;
      return actual.sign(...args);
    },
  };
});

const NOW_MS = 1_800_000_000_750;
const NOW_S = 1_800_000_000;

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ed = generateKeyPairSync('ed25519');
const edJwk = ed.privateKey.export({ format: 'jwk' });
// CDP's Ed25519 secret: base64 of the 32-byte seed, then the 32-byte public key
const ED_SECRET = Buffer.concat([
  Buffer.from(edJwk.d as string, 'base64url'),
  Buffer.from(edJwk.x as string, 'base64url'),
]).toString('base64');
const EC_PKCS8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decode(token: string) {
  const [header, claims, signature] = token.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
    input: Buffer.from(`${header}.${claims}`),
    signature: Buffer.from(signature, 'base64url'),
  };
}

function bearer(headers: Record<string, string> | undefined): string {
  const value = headers?.['Authorization'] ?? '';
  expect(value.startsWith('Bearer ')).toBe(true);
  return value.slice('Bearer '.length);
}

describe('CDP auth headers', () => {
  it.each([
    ['a PKCS8 PEM EC P-256 key', EC_PKCS8, 'ES256', ec.publicKey],
    [
      'a SEC1 PEM EC P-256 key',
      ec.privateKey.export({ type: 'sec1', format: 'pem' }).toString(),
      'ES256',
      ec.publicKey,
    ],
    ['a base64 Ed25519 seed and public key', ED_SECRET, 'EdDSA', ed.publicKey],
    // Simulate literal newline escapes copied from CDP's JSON key file
    [
      'a PEM EC key with JSON-escaped newlines',
      EC_PKCS8.replace(/\n/g, '\\n'),
      'ES256',
      ec.publicKey,
    ],
  ] as const)(
    'signs with %s a token CDP can verify',
    async (_, secret, alg, publicKey: KeyObject) => {
      const headers = await createCdpAuthHeaders('key-id', secret, () => NOW_MS)();

      const { header, claims, input, signature } = decode(bearer(headers['verify']));
      expect(header).toEqual({
        alg,
        kid: 'key-id',
        typ: 'JWT',
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
      });
      expect(claims).toEqual({
        sub: 'key-id',
        iss: 'cdp',
        uris: ['POST api.cdp.coinbase.com/platform/v2/x402/verify'],
        iat: NOW_S,
        nbf: NOW_S,
        exp: NOW_S + 120,
      });
      const valid =
        alg === 'ES256'
          ? verify('sha256', input, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
          : verify(null, input, publicKey, signature);
      expect(valid).toBe(true);
    },
  );

  it('binds each route to its own method and path', async () => {
    const headers = await createCdpAuthHeaders('key-id', EC_PKCS8)();

    // Path-keyed, not flat: the JWT is signed over method, host and path
    expect(Object.keys(headers).sort()).toEqual(['settle', 'supported', 'verify']);
    expect(decode(bearer(headers['verify'])).claims.uris).toEqual([
      'POST api.cdp.coinbase.com/platform/v2/x402/verify',
    ]);
    expect(decode(bearer(headers['settle'])).claims.uris).toEqual([
      'POST api.cdp.coinbase.com/platform/v2/x402/settle',
    ]);
    expect(decode(bearer(headers['supported'])).claims.uris).toEqual([
      'GET api.cdp.coinbase.com/platform/v2/x402/supported',
    ]);
  });

  // The SDK reads `verify` to tell a path-keyed object from a flat one, then
  // the route it calls
  it('signs only the routes that are read, each once', async () => {
    const create = createCdpAuthHeaders('key-id', EC_PKCS8);
    signatures.count = 0;
    const headers = await create();

    expect(bearer(headers['settle'])).toBe(bearer(headers['settle']));
    expect(signatures.count).toBe(1);
  });

  it('gives every token a fresh nonce', async () => {
    const create = createCdpAuthHeaders('key-id', ED_SECRET);
    const first = await create();
    const second = await create();

    const nonces = [first['verify'], first['settle'], second['verify']].map(
      (headers) => decode(bearer(headers)).header.nonce,
    );
    expect(new Set(nonces).size).toBe(3);
  });

  it.each([
    ['text that is no key', 'key-secret'],
    ['a 32-byte base64 value', Buffer.alloc(32, 7).toString('base64')],
    [
      'a P-384 EC key',
      generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    ],
    [
      'an RSA key',
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    ],
    ['a truncated PEM key', EC_PKCS8.slice(0, 80)],
  ])('refuses %s as CONFIG_INVALID at construction', (_, secret) => {
    let error: unknown;
    try {
      createCdpAuthHeaders('key-id', secret);
    } catch (err) {
      error = err;
    }
    expect(isCommerceError(error) && error.code).toBe('CONFIG_INVALID');
    expect(String((error as Error).message)).toContain('apiKeySecret');
    expect(String((error as Error).message)).not.toContain(secret);
  });
});

describe('remote facilitator binding with auth.type cdp', () => {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
  }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kinds: [], extensions: [], signers: {} }));
  });

  afterEach(async () => {
    requests.length = 0;
    await new Promise<void>((done) => server.close(() => done()));
  });

  async function listen(): Promise<string> {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('sends the supported route its own signed token', async () => {
    const binding = createRemoteFacilitatorBinding({
      url: await listen(),
      auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: EC_PKCS8 },
    });
    if (binding.kind !== 'remote') throw new Error('expected a remote binding');

    await binding.supported();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    const token = (requests[0]?.authorization ?? '').replace(/^Bearer /, '');
    const { claims, input, signature } = decode(token);
    expect(claims.uris).toEqual(['GET api.cdp.coinbase.com/platform/v2/x402/supported']);
    expect(
      verify('sha256', input, { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    ).toBe(true);
  });

  it('refuses to build a binding whose secret is unreadable', () => {
    expect(() =>
      createRemoteFacilitatorBinding({
        url: 'https://facilitator.example.com',
        auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: 'key-secret' },
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('never puts the credential in anything the binding describes', () => {
    const binding = createRemoteFacilitatorBinding({
      url: 'https://facilitator.example.com',
      auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: ED_SECRET },
    });
    // `describe` reaches logs, health details and doctor output
    expect(binding.describe).not.toContain(ED_SECRET);
    expect(binding.describe).not.toContain('key-id');
    expect(binding.describe).toContain('auth=cdp');
  });
});
