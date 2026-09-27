// HTTP helpers shared by the A2A and ACP adapters and the gateway's admin-token gate
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const BEARER_PREFIX = /^Bearer +/i;

/**
 * Builds a check of an `Authorization: Bearer <token>` header against a fixed
 * token. The scheme is case-insensitive (RFC 9110). Both sides are compared as
 * SHA-256 digests, because `timingSafeEqual` throws on a length mismatch and
 * would reveal the token's length; the expected digest is computed once here.
 */
export function createBearerCheck(expectedToken: string): (header: string | undefined) => boolean {
  const expected = sha256(expectedToken);
  return (header) => {
    if (header === undefined || !BEARER_PREFIX.test(header)) return false;
    const presented = header.replace(BEARER_PREFIX, '');
    return presented.length > 0 && timingSafeEqual(sha256(presented), expected);
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** A tagged result, so no body text can be mistaken for a failure */
export type BodyRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'unreadable' };

/**
 * Reads the unconsumed request stream the gateway hands an adapter, stopping
 * at the cap rather than buffering whatever arrives
 */
export async function readCappedBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) return { kind: 'too-large' };
      chunks.push(buffer);
    }
  } catch {
    return { kind: 'unreadable' };
  }
  return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Joins a base URL and a mount path with exactly one slash between them and
 * none at the end. Plain concatenation can yield `https://host//a2a`, which a
 * router may treat as a different path.
 */
export function joinUrl(baseUrl: string, mountPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${mountPath.replace(/^\/+|\/+$/g, '')}`;
}
