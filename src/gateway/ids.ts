// Default `IdGenerator`, used when the caller injects none
import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../core';

export function createDefaultIdGenerator(): IdGenerator {
  return {
    next(prefix?: string): string {
      const id = randomUUID();
      return prefix ? `${prefix}_${id}` : id;
    },
  };
}
