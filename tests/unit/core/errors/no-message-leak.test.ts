/**
 * Regression tests for an information-disclosure leak found in review
 * adversarial review (payments reviewing protocols).
 *
 * `toCommerceError` used to copy an arbitrary thrown Error's `message` into
 * the CommerceError. Because `message` is serialised by `toInfo()` and
 * `toErrorEnvelope()` and returned to clients over both HTTP and MCP, any
 * unexpected exception leaked internal detail verbatim.
 *
 * These tests own that boundary, alongside errors/**.
 */
import { describe, expect, it } from 'vitest';
import { toErrorEnvelope } from '../../../../src/core/domain/wire.js';
import {
  CommerceError,
  isCommerceError,
  toCommerceError,
} from '../../../../src/core/errors/index.js';

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

  it('keeps the original on `cause` so logs and diagnostics lose nothing', () => {
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

  it('does not leak through toErrorEnvelope() — the shape that reaches the wire', () => {
    const envelope = toErrorEnvelope(toCommerceError(new Error(SECRET)));
    const serialised = JSON.stringify(envelope);
    expect(serialised).not.toContain('internal-billing-db');
    expect(serialised).not.toContain('10.20.30.40');
    expect(serialised).not.toContain('svc_billing');
  });

  it('never serialises `cause`, even though it holds the sensitive value', () => {
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

  it('passes an existing CommerceError through untouched — its message was authored by us', () => {
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
