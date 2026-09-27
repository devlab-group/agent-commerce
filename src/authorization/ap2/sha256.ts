import { createHash } from 'node:crypto';

/** SHA-256, the only digest AP2 verification and signing use. A string is hashed as UTF-8 */
export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}
