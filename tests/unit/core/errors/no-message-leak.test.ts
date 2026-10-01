/**
 * `toCommerceError` must not copy an arbitrary Error's `message` into the
 * CommerceError: `message` reaches clients through `toInfo()` and
 * `toErrorEnvelope()`, and an unexpected exception can carry internal detail
 */
import { describe, expect, it } from 'vitest';
import { toErrorEnvelope } from '../../../../src/core/domain/wire';
import {
  CommerceError,
  isCommerceError,
  toCommerceError,
  toLogInfo,
} from '../../../../src/core/errors';

const SECRET =
  'connect ECONNREFUSED 10.20.30.40:5432 (internal-billing-db.corp.internal) user=svc_billing';

describe('toCommerceError does not leak internal error detail to clients', () => {
  it('does not copy an arbitrary Error message into the client-visible message', () => {
    const error = toCommerceError(new Error(SECRET));
    expect(error.message).not.toContain('internal-billing-db');
    expect(error.message).not.toContain('10.20.30.40');
    expect(error.message).toBe('Unexpected internal error');
    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('keeps the original on `cause`', () => {
    const original = new Error(SECRET);
    const error = toCommerceError(original);
    expect(error.cause).toBe(original);
    expect((error.cause as Error).message).toBe(SECRET);
  });

  it('does not leak through toInfo()', () => {
    const info = toCommerceError(new Error(SECRET)).toInfo();
    expect(JSON.stringify(info)).not.toContain('internal-billing-db');
    expect(JSON.stringify(info)).not.toContain('svc_billing');
  });

  it('does not leak through toErrorEnvelope(), the shape that reaches the wire', () => {
    const envelope = toErrorEnvelope(toCommerceError(new Error(SECRET)));
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('internal-billing-db');
    expect(serialized).not.toContain('10.20.30.40');
    expect(serialized).not.toContain('svc_billing');
  });

  it('never serializes `cause`, even though it holds the sensitive value', () => {
    const error = toCommerceError(new Error(SECRET));
    expect(JSON.stringify(toErrorEnvelope(error))).not.toContain(SECRET);
    expect(JSON.stringify(error.toInfo())).not.toContain(SECRET);
  });

  it('uses the caller-supplied fallback message, which is deliberate and reviewed', () => {
    const error = toCommerceError(new Error(SECRET), 'BACKEND_ERROR', 'Backend call failed');
    expect(error.message).toBe('Backend call failed');
    expect(error.code).toBe('BACKEND_ERROR');
    expect(error.httpStatus).toBe(502);
  });

  it('passes an existing CommerceError through untouched, since we wrote its message', () => {
    const original = new CommerceError('INPUT_INVALID', 'field "city" is required');
    const error = toCommerceError(original);
    expect(error).toBe(original);
    expect(error.message).toBe('field "city" is required');
  });

  it('handles non-Error throws (strings, objects, null) without leaking them', () => {
    for (const thrown of [SECRET, { secret: SECRET }, null, undefined, 42]) {
      const error = toCommerceError(thrown);
      expect(isCommerceError(error)).toBe(true);
      expect(JSON.stringify(error.toInfo())).not.toContain('internal-billing-db');
    }
  });
});

describe('toLogInfo gives operators the cause without its credentials', () => {
  it('adds the cause chain and cuts each URL to its scheme and host', () => {
    const socket = new Error('connect ECONNREFUSED https://svc:pw@rpc.example:8545/v2/KEY?token=Q');
    const transport = new TypeError('fetch failed', { cause: socket });
    const info = toLogInfo(
      new CommerceError('BACKEND_ERROR', 'Backend request failed', { cause: transport }),
    );
    expect(info.code).toBe('BACKEND_ERROR');
    expect(info.cause).toEqual([
      'TypeError: fetch failed',
      'Error: connect ECONNREFUSED https://rpc.example:8545',
    ]);
  });

  it('logs the original of a non-commerce throw, which the message hides', () => {
    expect(toLogInfo(new Error(SECRET)).cause).toEqual([`Error: ${SECRET}`]);
  });

  it('omits `cause` when there is none, and stops on a cyclic chain', () => {
    expect(toLogInfo(new CommerceError('INPUT_INVALID', 'bad input'))).not.toHaveProperty('cause');
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.assign(first, { cause: second });
    expect(toLogInfo(second).cause).toHaveLength(5);
  });
});
