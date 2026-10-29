// Locator expiry limits and shared EIP-3009 normalization for x402 and MPP
import { describe, expect, it } from 'vitest';
import { eip3009Locator, isoFromSeconds, permit2Locator } from '../../../src/payments/x402/locator';

const UINT256_MAX = (2n ** 256n - 1n).toString();

describe('isoFromSeconds', () => {
  it.each([
    ['0', '1970-01-01T00:00:00.000Z'],
    ['1767225600', '2026-01-01T00:00:00.000Z'],
    // The last second Date can represent
    ['8640000000000', '+275760-09-13T00:00:00.000Z'],
  ])('converts %s', (seconds, iso) => {
    expect(isoFromSeconds(seconds)).toBe(iso);
  });

  it.each([
    ['one second past Date', '8640000000001'],
    ['the uint256 maximum', UINT256_MAX],
    ['a hex value', '0x10'],
    ['an exponent', '1e3'],
    ['an empty string', ''],
    ['a negative value', '-1'],
  ])('has no time for %s', (_label, seconds) => {
    expect(isoFromSeconds(seconds)).toBeUndefined();
  });
});

describe('eip3009Locator', () => {
  const authorization = {
    from: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    value: '10000',
    validAfter: '0',
    validBefore: '1767225600',
    nonce: `0x${'AB'.repeat(32)}`,
  };

  it('checksums addresses and lowercases the nonce, so both rails agree on one authorization', () => {
    expect(
      eip3009Locator('eip155:84532', '0x036cbd53842c5426634e7929541ec2318f3dcf7e', authorization),
    ).toStrictEqual({
      v: 1,
      network: 'eip155:84532',
      method: 'eip3009',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      from: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      value: '10000',
      nonce: `0x${'ab'.repeat(32)}`,
      validAfter: '0',
      validBefore: '1767225600',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps a window Date cannot hold, without an expiry', () => {
    const locator = eip3009Locator('eip155:84532', authorization.to, {
      ...authorization,
      validBefore: UINT256_MAX,
    });
    expect(locator['validBefore']).toBe(UINT256_MAX);
    expect(locator).not.toHaveProperty('expiresAt');
  });
});

describe('permit2Locator', () => {
  it('keeps a deadline Date cannot hold, without an expiry', () => {
    const locator = permit2Locator('eip155:84532', {
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      owner: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
      to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      amount: '10000',
      nonce: '7',
      deadline: UINT256_MAX,
      validAfter: '0',
      proxy: '0x402085c248eea27d92e8b30b2c58ed07f9e20001',
    });
    expect(locator).toMatchObject({
      owner: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      deadline: UINT256_MAX,
    });
    expect(locator).not.toHaveProperty('expiresAt');
  });
});
