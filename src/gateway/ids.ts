/** Default `IdGenerator` used when the caller does not inject one. */
import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../core/index.js';

export function createDefaultIdGenerator(): IdGenerator {
  return {
    next(prefix?: string): string {
      const id = randomUUID();
      return prefix ? `${prefix}_${id}` : id;
    },
  };
}
