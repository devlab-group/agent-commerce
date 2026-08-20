import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../src/core/index.js';
import {
  assertDevKeyIsLocalOnly,
  assertPayToIsNotDevAddress,
  isLikelyLocalOrPrivateHost,
  isWellKnownDevKey,
} from '../../../src/payments/x402/dev-key-guard.js';
import { ANVIL_WELL_KNOWN_ACCOUNTS } from '../../../src/payments/x402/local-chain/accounts.js';

const DEV_KEY = ANVIL_WELL_KNOWN_ACCOUNTS[0].privateKey;
const REAL_KEY = `0x${'11'.repeat(32)}` as `0x${string}`;
const DEV_PAY_TO = ANVIL_WELL_KNOWN_ACCOUNTS[1].address;
const REAL_PAY_TO = `0x${'f0'.repeat(20)}`;

describe('isWellKnownDevKey', () => {
  it('recognises every Anvil well-known key, case-insensitively', () => {
    for (const account of ANVIL_WELL_KNOWN_ACCOUNTS) {
      expect(isWellKnownDevKey(account.privateKey)).toBe(true);
      expect(isWellKnownDevKey(account.privateKey.toUpperCase())).toBe(true);
    }
  });

  it('does not flag an arbitrary key as well-known', () => {
    expect(isWellKnownDevKey(REAL_KEY)).toBe(false);
  });
});

describe('isLikelyLocalOrPrivateHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '::1',
    '10.0.5.2',
    '192.168.1.10',
    '172.16.0.5',
    '172.31.255.255',
    'anvil',
    'oac-anvil',
  ])('treats %s as local/private', (host) => {
    expect(isLikelyLocalOrPrivateHost(host)).toBe(true);
  });

  it.each([
    'sepolia.base.org',
    'mainnet.infura.io',
    '8.8.8.8',
    'example.com',
    '172.32.0.1',
    '172.15.0.1',
  ])('treats %s as NOT local/private', (host) => {
    expect(isLikelyLocalOrPrivateHost(host)).toBe(false);
  });
});

describe('assertDevKeyIsLocalOnly — adversarial cases', () => {
  it('rejects a well-known dev key pointed at a public-looking RPC', () => {
    expect(() => assertDevKeyIsLocalOnly('https://sepolia.base.org', DEV_KEY)).toThrow();
    try {
      assertDevKeyIsLocalOnly('https://sepolia.base.org', DEV_KEY);
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCommerceError(err)).toBe(true);
      if (isCommerceError(err)) expect(err.code).toBe('CONFIG_INVALID');
    }
  });

  it('accepts a well-known dev key against a loopback RPC', () => {
    expect(() => assertDevKeyIsLocalOnly('http://127.0.0.1:8545', DEV_KEY)).not.toThrow();
  });

  it('accepts a well-known dev key against a docker-compose service name', () => {
    expect(() => assertDevKeyIsLocalOnly('http://anvil:8545', DEV_KEY)).not.toThrow();
  });

  it("allows a real (non-dev) key against a public RPC — someone's own facilitator", () => {
    expect(() => assertDevKeyIsLocalOnly('https://sepolia.base.org', REAL_KEY)).not.toThrow();
  });

  it('allows a real key against a loopback RPC too', () => {
    expect(() => assertDevKeyIsLocalOnly('http://127.0.0.1:8545', REAL_KEY)).not.toThrow();
  });

  it('rejects a malformed rpcUrl outright', () => {
    expect(() => assertDevKeyIsLocalOnly('not-a-url', DEV_KEY)).toThrow();
  });

  it('rejects a truncated key (63 hex chars) even against a loopback RPC', () => {
    const TRUNCATED_DEV_KEY = DEV_KEY.slice(0, -1); // drop the trailing hex char
    expect(TRUNCATED_DEV_KEY).toHaveLength(65); // '0x' + 63 hex chars
    try {
      assertDevKeyIsLocalOnly('http://127.0.0.1:8545', TRUNCATED_DEV_KEY);
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCommerceError(err)).toBe(true);
      if (isCommerceError(err)) expect(err.code).toBe('CONFIG_INVALID');
    }
  });

  it('rejects a malformed key even against a public-looking RPC (not silently treated as "someone else\'s real key")', () => {
    // Regression for the bug thefound: a shape check must
    // run before the well-known-key lookup, so a garbage string can never
    // fall through the `!isWellKnownDevKey` early exit and return cleanly.
    expect(() =>
      assertDevKeyIsLocalOnly('https://sepolia.base.org', 'not-a-private-key-at-all'),
    ).toThrow();
    try {
      assertDevKeyIsLocalOnly('https://sepolia.base.org', 'not-a-private-key-at-all');
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCommerceError(err)).toBe(true);
      if (isCommerceError(err)) expect(err.code).toBe('CONFIG_INVALID');
    }
  });

  it('rejects a key missing the 0x prefix', () => {
    expect(() => assertDevKeyIsLocalOnly('http://127.0.0.1:8545', DEV_KEY.slice(2))).toThrow();
  });

  it('rejects a key with non-hex characters', () => {
    const BAD_KEY = `0x${'zz'.repeat(32)}`;
    expect(() => assertDevKeyIsLocalOnly('http://127.0.0.1:8545', BAD_KEY)).toThrow();
  });
});

describe('assertPayToIsNotDevAddress — adversarial cases', () => {
  it('rejects a well-known dev payTo address pointed at a public-looking RPC', () => {
    expect(() => assertPayToIsNotDevAddress('https://mainnet.base.org', DEV_PAY_TO)).toThrow();
    try {
      assertPayToIsNotDevAddress('https://mainnet.base.org', DEV_PAY_TO);
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCommerceError(err)).toBe(true);
      if (isCommerceError(err)) expect(err.code).toBe('CONFIG_INVALID');
    }
  });

  it('accepts a well-known dev payTo address against a loopback RPC', () => {
    expect(() => assertPayToIsNotDevAddress('http://127.0.0.1:8545', DEV_PAY_TO)).not.toThrow();
  });

  it('accepts a well-known dev payTo address against a docker-compose service name', () => {
    expect(() => assertPayToIsNotDevAddress('http://anvil:8545', DEV_PAY_TO)).not.toThrow();
  });

  it("allows a real (non-dev) payTo against a public RPC — someone's own merchant wallet", () => {
    expect(() => assertPayToIsNotDevAddress('https://mainnet.base.org', REAL_PAY_TO)).not.toThrow();
  });

  it('is case-insensitive on the address comparison', () => {
    expect(() =>
      assertPayToIsNotDevAddress('https://mainnet.base.org', DEV_PAY_TO.toUpperCase()),
    ).toThrow();
    expect(() =>
      assertPayToIsNotDevAddress('https://mainnet.base.org', DEV_PAY_TO.toLowerCase()),
    ).toThrow();
  });

  it('rejects a malformed rpcUrl outright when payTo is a dev address', () => {
    expect(() => assertPayToIsNotDevAddress('not-a-url', DEV_PAY_TO)).toThrow();
  });
});
