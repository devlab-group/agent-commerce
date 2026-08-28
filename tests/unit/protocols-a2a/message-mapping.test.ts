/**
 * The invocation envelope: what the adapter accepts, and what it refuses.
 *
 * Terminology, deliberately: a rejected `resource` names an *unknown canonical
 * resource*, never an "unknown skill" — A2A skills are discovery descriptors,
 * not dispatch identifiers, and resolution happens in the pipeline anyway.
 */
import { describe, expect, it } from 'vitest';
import { isCommerceError, PAYMENT_INPUT_FIELD } from '../../../src/core/index.js';
import { parseInvocation } from '../../../src/protocols/a2a/message-mapping.js';

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

function expectRejected(params: unknown, code: 'INPUT_INVALID' | 'PROTOCOL_UNSUPPORTED'): void {
  try {
    parseInvocation(params);
    expect.unreachable();
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    if (isCommerceError(error)) expect(error.code).toBe(code);
  }
}

describe('parseInvocation — accepted envelope', () => {
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

describe('parseInvocation — malformed envelopes', () => {
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

describe('parseInvocation — legal A2A this adapter does not serve', () => {
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
    expectRejected(params, 'PROTOCOL_UNSUPPORTED');
  });

  it.each([
    ['a params-level taskId', { taskId: 'task-1' }],
    ['a params-level contextId', { contextId: 'ctx-1' }],
  ])('rejects %s', (_label, extra) => {
    expectRejected(
      { ...(envelope({ resource: 'ping' }) as object), ...extra },
      'PROTOCOL_UNSUPPORTED',
    );
  });

  it.each([
    ['a message-level taskId', { taskId: 'task-1' }],
    ['a message-level contextId', { contextId: 'ctx-1' }],
    ['referenced tasks', { referenceTaskIds: ['task-1'] }],
  ])('rejects %s', (_label, overrides) => {
    expectRejected(envelope({ resource: 'ping' }, overrides), 'PROTOCOL_UNSUPPORTED');
  });

  it('accepts an empty referenceTaskIds array, which continues nothing', () => {
    expect(
      parseInvocation(envelope({ resource: 'ping' }, { referenceTaskIds: [] })).resourceId,
    ).toBe('ping');
  });
});
