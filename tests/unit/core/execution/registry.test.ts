import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../../src/core/errors/index.js';
import {
  createResourceRegistry,
  ResourceRegistryImpl,
} from '../../../../src/core/execution/registry.js';
import { makeResource } from './helpers.js';

describe('ResourceRegistryImpl', () => {
  it('resolves resources by id', () => {
    const a = makeResource({ id: 'a' });
    const b = makeResource({ id: 'b', exposedVia: ['mcp'] });
    const registry = new ResourceRegistryImpl([a, b]);

    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.has('a')).toBe(true);
    expect(registry.has('missing')).toBe(false);
  });

  it('lists all resources in input order', () => {
    const a = makeResource({ id: 'a' });
    const b = makeResource({ id: 'b' });
    const registry = createResourceRegistry([a, b]);
    expect(registry.list()).toEqual([a, b]);
  });

  it('filters by exposedVia protocol', () => {
    const httpOnly = makeResource({ id: 'http-only', exposedVia: ['http'] });
    const both = makeResource({ id: 'both', exposedVia: ['http', 'mcp'] });
    const mcpOnly = makeResource({ id: 'mcp-only', exposedVia: ['mcp'] });
    const registry = createResourceRegistry([httpOnly, both, mcpOnly]);

    expect(registry.listExposedVia('http').map((r) => r.id)).toEqual(['http-only', 'both']);
    expect(registry.listExposedVia('mcp').map((r) => r.id)).toEqual(['both', 'mcp-only']);
  });

  it('rejects duplicate resource ids', () => {
    const a = makeResource({ id: 'dup' });
    const b = makeResource({ id: 'dup' });

    expect(() => new ResourceRegistryImpl([a, b])).toThrowError();
    try {
      new ResourceRegistryImpl([a, b]);
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (isCommerceError(error)) {
        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.message).toContain('dup');
      }
    }
  });

  it('handles an empty resource list', () => {
    const registry = createResourceRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.has('anything')).toBe(false);
  });
});
