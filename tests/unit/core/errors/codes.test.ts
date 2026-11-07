import { describe, expect, it } from 'vitest';
import { toErrorEnvelope } from '../../../../src/core/domain/wire';
import {
  COMMERCE_ERROR_CODES,
  COMMERCE_ERROR_HTTP_STATUS,
  CommerceError,
  RETRYABLE_ERROR_CODES,
} from '../../../../src/core/errors';

describe('COMMERCE_ERROR_HTTP_STATUS', () => {
  it('maps every code to an error status, never to a delivery', () => {
    for (const code of COMMERCE_ERROR_CODES) {
      expect(COMMERCE_ERROR_HTTP_STATUS[code], code).toBeGreaterThanOrEqual(400);
      expect(COMMERCE_ERROR_HTTP_STATUS[code], code).toBeLessThan(600);
    }
  });

  it('never answers an authorization failure with 402, which tells a client to pay', () => {
    const authorizationCodes = COMMERCE_ERROR_CODES.filter((code) =>
      code.startsWith('AUTHORIZATION_'),
    );
    expect(authorizationCodes.length).toBeGreaterThan(0);
    for (const code of authorizationCodes) {
      expect(COMMERCE_ERROR_HTTP_STATUS[code], code).not.toBe(402);
    }
  });
});

describe('CommerceError retryable', () => {
  it('follows the code when the option is absent', () => {
    for (const code of COMMERCE_ERROR_CODES) {
      expect(new CommerceError(code, 'x').retryable, code).toBe(RETRYABLE_ERROR_CODES.has(code));
    }
  });

  it.each([
    ['PAYMENT_REPLAYED', true],
    ['GATEWAY_BUSY', false],
  ] as const)('lets one %s error override its default with %s', (code, retryable) => {
    const error = new CommerceError(code, 'x', { retryable });

    expect(error.retryable).toBe(retryable);
    expect(toErrorEnvelope(error).retryable).toBe(retryable);
  });
});
