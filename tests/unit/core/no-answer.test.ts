// Request errors classified as unreachable
import { describe, expect, it } from 'vitest';
import { gotNoAnswer } from '../../../src/core/no-answer';

// undici's fetch error, with the Node error code on its cause
const fetchFailed = (code: string | undefined, message = 'x') =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

describe('gotNoAnswer', () => {
  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ])('is true for a fetch that failed with %s', (code) => {
    expect(gotNoAnswer(fetchFailed(code))).toBe(true);
  });

  it.each([
    ['a hostname that does not resolve', fetchFailed('ENOTFOUND')],
    ['a certificate for another host', fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID')],
    ['an expired certificate', fetchFailed('CERT_HAS_EXPIRED')],
    ['a server that does not speak TLS', fetchFailed('ERR_SSL_PACKET_LENGTH_TOO_LONG')],
    ['a port fetch refuses to use', fetchFailed(undefined, 'bad port')],
    ['a fetch error without a cause', new TypeError('fetch failed')],
    ['a JSON-RPC error code', Object.assign(new Error('no method'), { code: -32601 })],
    ['an unrecognized error', new Error('boom')],
    ['a thrown string', 'ECONNREFUSED'],
    ['nothing', undefined],
  ])('is false for %s', (_label, err) => {
    expect(gotNoAnswer(err)).toBe(false);
  });

  it('is true for a timeout named TimeoutError, at any depth', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(gotNoAnswer(timeout)).toBe(true);
    expect(
      gotNoAnswer(new Error('wrapped', { cause: new Error('twice', { cause: timeout }) })),
    ).toBe(true);
  });

  it('reads the code on an AggregateError from a connection to several addresses', () => {
    const both = Object.assign(new AggregateError([new Error('a'), new Error('b')]), {
      code: 'ECONNREFUSED',
    });
    expect(gotNoAnswer(new TypeError('fetch failed', { cause: both }))).toBe(true);
  });

  it("treats a caller's timeout names as no answer, and only for that caller", () => {
    const sdkTimeout = Object.assign(new Error('timed out'), { name: 'FacilitatorTimeoutError' });
    expect(gotNoAnswer(sdkTimeout, ['FacilitatorTimeoutError'])).toBe(true);
    expect(gotNoAnswer(sdkTimeout)).toBe(false);
  });

  it('returns false for a cause cycle instead of looping', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(gotNoAnswer(a)).toBe(false);
  });
});
