// Checks RFC 8785 serialization against the spec's examples and the
// canonicalize reference implementation
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/core/canonical-json';

describe('canonicalJson', () => {
  it('orders keys by UTF-16 code units, as the RFC 8785 sorting example does', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('formats numbers as RFC 8785 appendix B does', () => {
    const numbers = [0, -0, 5e-324, 1.7976931348623157e308, 9007199254740992, 1e21, 1e-6, 1e-7];
    expect(canonicalJson(numbers)).toBe(
      '[0,0,5e-324,1.7976931348623157e+308,9007199254740992,1e+21,0.000001,1e-7]',
    );
  });

  it.each([
    ['nested containers', { b: [1, { d: null, c: true }], a: {}, e: [] }],
    ['escapes and non-ASCII', { s: '\u0000\b\f\n\r\t"\\/\u001f é😀' }],
    ['numbers', { n: [0.1, 0.30000000000000004, -1.5e-10, 123456789012345680000, 1e300] }],
    ['a scalar', 'plain'],
  ])('matches the canonicalize reference for %s', (_name, value) => {
    expect(canonicalJson(value)).toBe(canonicalize(value));
  });

  it.each([
    ['a lone surrogate in a string', { s: 'a\ud800b' }],
    ['a lone surrogate in a key', { '\udc00': 1 }],
    ['a lone surrogate in an array', ['ok', '\ud800']],
    ['an infinite number', { n: Number.POSITIVE_INFINITY }],
    ['NaN', [Number.NaN]],
  ])('returns undefined for %s, outside what RFC 8785 serializes', (_name, value) => {
    expect(() => canonicalize(value)).toThrow();
    expect(canonicalJson(value)).toBeUndefined();
  });
});
