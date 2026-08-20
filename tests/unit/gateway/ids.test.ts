import { describe, expect, it } from 'vitest';
import { createDefaultIdGenerator } from '../../../src/gateway/ids.js';

describe('createDefaultIdGenerator', () => {
  it('generates unique ids', () => {
    const ids = createDefaultIdGenerator();
    const a = ids.next();
    const b = ids.next();
    expect(a).not.toBe(b);
  });

  it('prefixes the id when a prefix is given', () => {
    const ids = createDefaultIdGenerator();
    const id = ids.next('evt');
    expect(id.startsWith('evt_')).toBe(true);
  });

  it('omits the prefix separator when no prefix is given', () => {
    const ids = createDefaultIdGenerator();
    const id = ids.next();
    expect(id).not.toContain('_');
  });
});
