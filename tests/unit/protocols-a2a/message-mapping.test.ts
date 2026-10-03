/**
 * The invocation envelope: what the adapter accepts, and what it refuses.
 *
 * A rejected `resource` is an unknown canonical resource, never an "unknown
 * skill": A2A skills are discovery descriptors, not dispatch identifiers.
 */
import { describe, expect, it } from 'vitest';
import { isCommerceError, PAYMENT_INPUT_FIELD } from '../../../src/core';
import { parseInvocation } from '../../../src/protocols/a2a/message-mapping';

function envelope(data: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    message: {
      role: 'ROLE_USER',
      messageId: 'msg-1',
      parts: [{ data, mediaType: 'application/json' }],
      ...overrides,
    },
  };
}

// Check the specific A2A error code when the mapper supplies one
function expectRejected(
  params: unknown,
  code: 'INPUT_INVALID' | 'PROTOCOL_UNSUPPORTED',
  a2aErrorCode?: number,
): void {
  try {
    parseInvocation(params);
    expect.unreachable();
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    if (isCommerceError(error)) {
      expect(error.code).toBe(code);
      expect(error.details?.['a2aErrorCode']).toBe(a2aErrorCode);
    }
  }
}

describe('parseInvocation: accepted envelope', () => {
  it('maps a valid resource envelope to a resource id and input', () => {
    expect(
      parseInvocation(envelope({ resource: 'market_report', input: { symbol: 'ETH' } })),
    ).toEqual({
      resourceId: 'market_report',
      input: { symbol: 'ETH' },
      messageId: 'msg-1',
    });
  });

  it('treats an absent input as no arguments', () => {
    expect(parseInvocation(envelope({ resource: 'ping' }))).toEqual({
      resourceId: 'ping',
      input: {},
      messageId: 'msg-1',
    });
  });

  it('carries a payment proof through in the reserved input field, untouched', () => {
    const result = parseInvocation(
      envelope({
        resource: 'market_report',
        input: { symbol: 'ETH', [PAYMENT_INPUT_FIELD]: 'base64-proof' },
      }),
    );
    expect(result.input[PAYMENT_INPUT_FIELD]).toBe('base64-proof');
  });

  it('accepts a part with no declared media type', () => {
    const params = { message: { role: 'ROLE_USER', parts: [{ data: { resource: 'ping' } }] } };
    expect(parseInvocation(params).resourceId).toBe('ping');
  });

  it('omits messageId when the client sent none', () => {
    const params = { message: { role: 'ROLE_USER', parts: [{ data: { resource: 'ping' } }] } };
    expect(parseInvocation(params)).not.toHaveProperty('messageId');
  });
});

describe('parseInvocation: malformed envelopes', () => {
  it.each([
    ['not an object', 42],
    ['no message', {}],
    ['no parts array', { message: { role: 'ROLE_USER' } }],
    ['no role', { message: { parts: [] } }],
  ])('rejects %s', (_label, params) => {
    expectRejected(params, 'INPUT_INVALID');
  });

  it('rejects an empty parts array', () => {
    expectRejected({ message: { role: 'ROLE_USER', parts: [] } }, 'INPUT_INVALID');
  });

  it('rejects a part whose data is not an object', () => {
    expectRejected(envelope('market_report'), 'INPUT_INVALID');
    expectRejected(envelope(['market_report']), 'INPUT_INVALID');
    expectRejected(envelope(null), 'INPUT_INVALID');
  });

  it('rejects a missing resource', () => {
    expectRejected(envelope({ input: { symbol: 'ETH' } }), 'INPUT_INVALID');
  });

  it('rejects an empty resource', () => {
    expectRejected(envelope({ resource: '' }), 'INPUT_INVALID');
  });

  it('rejects a non-string resource', () => {
    expectRejected(envelope({ resource: 7 }), 'INPUT_INVALID');
  });

  it.each([
    ['a string', 'ETH'],
    ['an array', ['ETH']],
    ['null', null],
  ])('rejects an input that is %s', (_label, input) => {
    expectRejected(envelope({ resource: 'market_report', input }), 'INPUT_INVALID');
  });

  it('rejects an unsupported role', () => {
    expectRejected(envelope({ resource: 'ping' }, { role: 'ROLE_AGENT' }), 'INPUT_INVALID');
    expectRejected(envelope({ resource: 'ping' }, { role: 'user' }), 'INPUT_INVALID');
  });
});

describe('parseInvocation: legal A2A this adapter does not serve', () => {
  it('rejects a file part', () => {
    const params = {
      message: { role: 'ROLE_USER', parts: [{ file: { uri: 'https://example.com/a.pdf' } }] },
    };
    expectRejected(params, 'PROTOCOL_UNSUPPORTED');
  });

  it('rejects a raw binary file part', () => {
    const params = { message: { role: 'ROLE_USER', parts: [{ file: { bytes: 'AAAA' } }] } };
    expectRejected(params, 'PROTOCOL_UNSUPPORTED');
  });

  it('rejects a text part', () => {
    const params = { message: { role: 'ROLE_USER', parts: [{ text: 'get me the report' }] } };
    expectRejected(params, 'PROTOCOL_UNSUPPORTED');
  });

  it('rejects multiple input parts rather than picking one', () => {
    const params = {
      message: {
        role: 'ROLE_USER',
        parts: [
          { data: { resource: 'weather_basic', input: {} } },
          { data: { resource: 'market_report', input: {} } },
        ],
      },
    };
    expectRejected(params, 'PROTOCOL_UNSUPPORTED');
  });

  it('rejects a data part alongside a text part', () => {
    const params = {
      message: {
        role: 'ROLE_USER',
        parts: [{ text: 'please' }, { data: { resource: 'market_report' } }],
      },
    };
    expectRejected(params, 'PROTOCOL_UNSUPPORTED');
  });

  it('rejects a non-JSON media type', () => {
    const params = {
      message: {
        role: 'ROLE_USER',
        parts: [{ data: { resource: 'ping' }, mediaType: 'application/xml' }],
      },
    };
    expectRejected(params, 'PROTOCOL_UNSUPPORTED', -32005);
  });

  // Every supplied task id is unknown to this stateless adapter
  it.each([
    ['a params-level taskId', { taskId: 'task-1' }, -32001],
    ['a params-level contextId', { contextId: 'ctx-1' }, undefined],
  ])('rejects %s', (_label, extra, a2aErrorCode) => {
    expectRejected(
      { ...(envelope({ resource: 'ping' }) as object), ...extra },
      'PROTOCOL_UNSUPPORTED',
      a2aErrorCode,
    );
  });

  it.each([
    ['a message-level taskId', { taskId: 'task-1' }, -32001],
    ['a message-level contextId', { contextId: 'ctx-1' }, undefined],
    ['referenced tasks', { referenceTaskIds: ['task-1'] }, undefined],
  ])('rejects %s', (_label, overrides, a2aErrorCode) => {
    expectRejected(envelope({ resource: 'ping' }, overrides), 'PROTOCOL_UNSUPPORTED', a2aErrorCode);
  });

  it('accepts an empty referenceTaskIds array, which continues nothing', () => {
    expect(
      parseInvocation(envelope({ resource: 'ping' }, { referenceTaskIds: [] })).resourceId,
    ).toBe('ping');
  });
});

/**
 * Part shapes the official SDK produces. A2A v1 flattened the v0.3 `file`
 * object into a content oneof, so these are what a conformant client sends,
 * checked here as well as in the SDK conformance suite.
 */
describe('parseInvocation: A2A v1 part spellings', () => {
  it.each([
    ['inline bytes', { raw: 'QUFBQQ==', filename: 'a.bin', mediaType: 'application/octet-stream' }],
    ['a url part', { url: 'https://example.com/a.pdf', mediaType: 'application/pdf' }],
  ])('rejects %s', (_label, part) => {
    expectRejected({ message: { role: 'ROLE_USER', parts: [part] } }, 'PROTOCOL_UNSUPPORTED');
  });
});
