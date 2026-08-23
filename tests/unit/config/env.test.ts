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
  // `${A:-${B}}` is not resolvable: `[^}]*` cannot span the inner `}`, so the
  // match consumes `${A:-${B` and a stray `}` is left as ordinary text.
  //
  // The first fix caught this by scanning the *result*, which only works on the
  // branch where `A` is unset — the leftover `${B}` is visible. With `A` set —
  // the normal case, and the entire reason someone writes a default —
  // substitution succeeded and the stray `}` was appended to the value with
  // nothing to notice it. For `adminToken` that means the gateway compares
  // against a credential the operator does not hold. So the decision moved to
  // the *template*, and `A` set is the case that matters most here.
  it.each([
    ['neither variable set', {}],
    ['the inner variable set', { B: 'bee' }],
    ['the outer variable set — the branch the result-scan missed', { A: 'real-secret-token' }],
    ['both set', { A: 'real-secret-token', B: 'bee' }],
  ])('rejects ${A:-${B}} when %s', (_label, env) => {
    expect(() => substituteEnv({ x: '${A:-${B}}' }, env)).toThrowError(/nests placeholders/);
  });

  it('never quotes a resolved value back in an error', () => {
    // The result-scan reproduced a verbatim fragment of the resolved secret
    // into the message and into `details`. Deciding from the template means a
    // value that merely looks like a placeholder is passed through untouched.
    expect(substituteEnv({ x: '${SECRET}' }, { SECRET: 'prefix-${INNER}-suffix' })).toEqual({
      x: 'prefix-${INNER}-suffix',
    });
  });

  // Valid shell, unsupported here, and previously loaded as literal text. Most
  // fields reject the literal downstream; `adminToken` does not, and would run
  // the gateway with `"${ADMIN_TOKEN-fallback}"` as the ledger credential while
  // the operator believed an env secret gated it.
  it.each(['${VAR-default}', '${VAR:=default}', '${VAR:?message}'])(
    'rejects the unsupported shell form %s rather than loading it literally',
    (template) => {
      expect(() => substituteEnv({ x: template }, { VAR: 'v' })).toThrowError(
        /not a supported placeholder/,
      );
    },
  );

  it('control: a bare $VAR is left alone — it is not brace-shaped', () => {
    expect(substituteEnv({ x: 'pa$$word and $VAR' }, { VAR: 'v' })).toEqual({
      x: 'pa$$word and $VAR',
    });
  });

  it('control: a plain default still resolves', () => {
    expect(substituteEnv({ x: '${A:-fallback}' }, {})).toEqual({ x: 'fallback' });
  });

  it('control: a "${" with no closing brace is ordinary text, not a placeholder', () => {
    expect(substituteEnv({ x: 'cost is ${5' }, {})).toEqual({ x: 'cost is ${5' });
  });
});
