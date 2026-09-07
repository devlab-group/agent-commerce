/**
 * Bearer authentication for the ACP checkout endpoints.
 *
 * Bearer is the only scheme this release accepts (config refuses any other),
 * discovery stays public, and a `Signature` header is never allowed to stand
 * in for the token - signature verification is not implemented and not
 * advertised, so treating one as authentication would be an unauthenticated
 * checkout endpoint dressed as a secure one.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = /^Bearer +/i;

/**
 * Constant-time comparison of the presented token against the configured one.
 *
 * Both sides are hashed first: `timingSafeEqual` throws on a length mismatch,
 * and comparing raw tokens would leak the configured length through that throw
 * (and through the early return that avoiding it invites). Digests are always
 * 32 bytes, so every wrong token costs exactly the same.
 */
export function isAuthorizedBearer(header: string | undefined, expectedToken: string): boolean {
  if (header === undefined) return false;
  if (!BEARER_PREFIX.test(header)) return false;
  const presented = header.replace(BEARER_PREFIX, '');
  if (presented.length === 0) return false;
  return timingSafeEqual(sha256(presented), sha256(expectedToken));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
