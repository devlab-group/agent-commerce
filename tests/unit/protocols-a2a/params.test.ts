// Check parsed values, defaults, page cursors and accepted input forms.
// HTTP refusal codes are covered in tests/conformance/a2a/params.test.ts.
import { describe, expect, it } from 'vitest';
import type { CommerceError } from '../../../src/core';
import {
  encodePageToken,
  readGetTaskParams,
  readListTasksParams,
  readSendMessageParams,
} from '../../../src/protocols/a2a/params';

function refusal(read: () => unknown): string | undefined {
  try {
    read();
  } catch (err) {
    return (err as CommerceError).code;
  }
  return undefined;
}

const CURSOR = { updatedAt: '2026-11-22T10:00:00.000Z', id: 'f3b1c2d4-task' };

describe('readListTasksParams', () => {
  it('applies the defaults to an empty request', () => {
    expect(readListTasksParams({})).toEqual({ pageSize: 50, includeArtifacts: false });
  });

  it('treats an empty contextId, an unspecified status and an empty pageToken as absent', () => {
    expect(
      readListTasksParams({ contextId: '', status: 'TASK_STATE_UNSPECIFIED', pageToken: '' }),
    ).toEqual({ pageSize: 50, includeArtifacts: false });
  });

  it('reads every field, under either name', () => {
    const expected = {
      contextId: 'ctx-1',
      status: 'TASK_STATE_COMPLETED',
      pageSize: 100,
      after: CURSOR,
      historyLength: 0,
      statusTimestampAfter: '2026-11-22T10:00:00.123456789Z',
      includeArtifacts: true,
    };
    expect(
      readListTasksParams({
        contextId: 'ctx-1',
        status: 'TASK_STATE_COMPLETED',
        pageSize: 100,
        pageToken: encodePageToken(CURSOR),
        historyLength: 0,
        statusTimestampAfter: '2026-11-22T10:00:00.123456789Z',
        includeArtifacts: true,
      }),
    ).toEqual(expected);
    expect(
      readListTasksParams({
        context_id: 'ctx-1',
        status: 'TASK_STATE_COMPLETED',
        page_size: '100',
        page_token: encodePageToken(CURSOR),
        history_length: '0',
        status_timestamp_after: '2026-11-22T10:00:00.123456789Z',
        include_artifacts: true,
      }),
    ).toEqual(expected);
  });

  it.each([
    // Without the alphabet check, Buffer.from would skip `!` and decode the cursor
    [
      'an issued token with a character outside base64url',
      `${encodePageToken(CURSOR).slice(0, 4)}!${encodePageToken(CURSOR).slice(4)}`,
    ],
    ['base64url that is not JSON', Buffer.from('not json').toString('base64url')],
    ['an object, not a pair', Buffer.from(JSON.stringify(CURSOR)).toString('base64url')],
    ['an offset timestamp', encodePageToken({ ...CURSOR, updatedAt: '2026-11-22T11:00:00+01:00' })],
    ['an empty id', encodePageToken({ ...CURSOR, id: '' })],
    ['a number', 7],
  ])('refuses a pageToken that is %s', (_label, pageToken) => {
    expect(refusal(() => readListTasksParams({ pageToken }))).toBe('INPUT_INVALID');
  });

  it.each([
    ['30 February', '2026-02-30T10:00:00Z'],
    ['hour 24', '2026-11-22T24:00:00Z'],
    ['no seconds', '2026-11-22T10:00Z'],
    ['a lowercase z', '2026-11-22T10:00:00z'],
    ['ten fraction digits', '2026-11-22T10:00:00.1234567890Z'],
  ])('refuses a statusTimestampAfter with %s', (_label, statusTimestampAfter) => {
    expect(refusal(() => readListTasksParams({ statusTimestampAfter }))).toBe('INPUT_INVALID');
  });

  it('accepts pageSize 1 and refuses 101, as a number or a string', () => {
    expect(readListTasksParams({ pageSize: 1 }).pageSize).toBe(1);
    expect(readListTasksParams({ pageSize: '1' }).pageSize).toBe(1);
    expect(refusal(() => readListTasksParams({ pageSize: '101' }))).toBe('INPUT_INVALID');
  });
});

describe('ProtoJSON integers', () => {
  it.each([
    ['a decimal string', '12', 12],
    ['the int32 maximum', 2_147_483_647, 2_147_483_647],
  ])('reads %s', (_label, historyLength, expected) => {
    expect(readGetTaskParams({ id: 't', historyLength }).historyLength).toBe(expected);
  });

  it.each([
    ['a hex string', '0x10'],
    ['an exponent string', '1e2'],
    ['a padded string', ' 3'],
    ['an empty string', ''],
    ['a value past int32', 2_147_483_648],
    ['a boolean', true],
    ['an array', [3]],
  ])('refuses %s', (_label, historyLength) => {
    expect(refusal(() => readGetTaskParams({ id: 't', historyLength }))).toBe('INPUT_INVALID');
  });
});

describe('field names', () => {
  it('renames only an underscore before a lowercase letter or digit', () => {
    // `history_Length` is not a proto name: it is an unknown field, ignored
    expect(readGetTaskParams({ id: 't', history_Length: -1 })).toEqual({ id: 't' });
  });

  it('keeps an own __proto__ key from changing the prototype', () => {
    const params = readSendMessageParams(JSON.parse('{"__proto__": {"polluted": true}}')).params;
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect((params as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('readSendMessageParams', () => {
  it('reads the configuration it will act on', () => {
    expect(
      readSendMessageParams({
        configuration: { history_length: '2', return_immediately: true },
      }),
    ).toMatchObject({ historyLength: 2, returnImmediately: true });
  });

  it('defaults returnImmediately to false', () => {
    expect(readSendMessageParams({ configuration: {} })).toMatchObject({
      returnImmediately: false,
    });
    expect(readSendMessageParams({})).toMatchObject({ returnImmediately: false });
  });

  it.each([
    ['parts that are not a list', { message_id: 'm', parts: 'p' }, { messageId: 'm', parts: 'p' }],
    ['a part that is not an object', { parts: [7] }, { parts: [7] }],
  ])('passes on %s for the message check to refuse', (_label, message, expected) => {
    expect(readSendMessageParams({ message }).params).toEqual({ message: expected });
  });

  it('renames the message and its parts, and leaves data and metadata values alone', () => {
    const { params } = readSendMessageParams({
      message: {
        message_id: 'm',
        metadata: { some_key: 1 },
        parts: [{ data: { resource: 'r', input: { max_age: 5 } }, media_type: 'application/json' }],
      },
      metadata: { request_note: 'x' },
    });
    expect(params).toEqual({
      message: {
        messageId: 'm',
        metadata: { some_key: 1 },
        parts: [{ data: { resource: 'r', input: { max_age: 5 } }, mediaType: 'application/json' }],
      },
      metadata: { request_note: 'x' },
    });
  });
});
