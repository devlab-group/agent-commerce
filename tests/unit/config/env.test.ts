import { describe, expect, it } from 'vitest';
import { substituteEnv } from '../../../src/config/env.js';
import { isCommerceError } from '../../../src/core/index.js';

describe('substituteEnv', () => {
  it('leaves non-template strings unchanged', () => {
    expect(substituteEnv('plain string', {})).toBe('plain string');
  });

  it('substitutes a simple ${VAR}', () => {
    expect(substituteEnv('${FOO}', { FOO: 'bar' })).toBe('bar');
  });

  it('substitutes a ${VAR} embedded in a larger string', () => {
    expect(substituteEnv('http://${HOST}:${PORT}/x', { HOST: 'example.com', PORT: '8080' })).toBe(
      'http://example.com:8080/x',
    );
  });

  it('throws CONFIG_INVALID naming the variable when unresolved', () => {
    try {
      substituteEnv('${MISSING}', {});
      expect.unreachable();
    } catch (error) {
      expect(isCommerceError(error)).toBe(true);
      if (isCommerceError(error)) {
        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.message).toContain('MISSING');
      }
    }
  });

  it('uses the default in ${VAR:-default} when unset', () => {
    expect(substituteEnv('${MISSING:-fallback}', {})).toBe('fallback');
  });

  it('uses the default in ${VAR:-default} when set to an empty string', () => {
    expect(substituteEnv('${EMPTY:-fallback}', { EMPTY: '' })).toBe('fallback');
  });

  it('prefers the env value over the default when set', () => {
    expect(substituteEnv('${SET:-fallback}', { SET: 'actual' })).toBe('actual');
  });

  it('supports an empty default value', () => {
    expect(substituteEnv('${MISSING:-}', {})).toBe('');
  });

  it('recurses into nested objects and arrays', () => {
    const input = {
      a: '${A}',
      b: [{ c: '${B}' }, 'literal'],
      d: 42,
      e: true,
      f: null,
    };
    const result = substituteEnv(input, { A: 'aVal', B: 'bVal' });
    expect(result).toEqual({ a: 'aVal', b: [{ c: 'bVal' }, 'literal'], d: 42, e: true, f: null });
  });

  it('leaves numbers, booleans and null untouched', () => {
    expect(substituteEnv(42, {})).toBe(42);
    expect(substituteEnv(true, {})).toBe(true);
    expect(substituteEnv(null, {})).toBe(null);
  });

  it('includes the config path in the unresolved-variable error', () => {
    try {
      substituteEnv({ merchant: { publicBaseUrl: '${MISSING}' } }, {});
      expect.unreachable();
    } catch (error) {
      if (isCommerceError(error)) {
        expect(error.message).toContain('merchant.publicBaseUrl');
      }
    }
  });
});

describe('nested placeholders and the unresolved-placeholder promise', () => {
  // The module header promises an unresolved placeholder fails loading
  // immediately. `${A:-${B}}` produced the literal string `${B}` instead:
  // `[^}]*` cannot span the inner `}`, so the default captured is `${B` and
  // the trailing `}` is ordinary text. Silently passing an unresolved
  // placeholder into a payment configuration is the failure mode the promise
  // exists to prevent, so this is now an error either way.
  it.each([
    ['neither variable set', {}],
    ['the inner variable set', { B: 'bee' }],
  ])('rejects ${A:-${B}} when %s', (_label, env) => {
    expect(() => substituteEnv({ x: '${A:-${B}}' }, env)).toThrowError(/unresolved placeholder/);
  });

  it('control: a plain default still resolves', () => {
    expect(substituteEnv({ x: '${A:-fallback}' }, {})).toEqual({ x: 'fallback' });
  });

  it('control: a "${" with no closing brace is ordinary text, not a placeholder', () => {
    expect(substituteEnv({ x: 'cost is ${5' }, {})).toEqual({ x: 'cost is ${5' });
  });
});
