// Address checks per family
import { describe, expect, it } from 'vitest';
import {
  isBurnAddress,
  isTransactionReference,
  normalizeAddress,
  sameAddress,
} from '../../../src/payments/x402/addresses';
import { requireX402Network } from '../../../src/payments/x402/networks';

const BASE = requireX402Network('eip155:8453', 'test');
const SOLANA = requireX402Network('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'test');
const NEAR = requireX402Network('near:mainnet', 'test');

describe('EVM addresses', () => {
  it('accepts 20 hex bytes in any letter case and keeps them as given', () => {
    const mixed = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    expect(normalizeAddress(BASE, mixed)).toBe(mixed);
    expect(sameAddress(BASE, mixed, mixed.toLowerCase())).toBe(true);
  });

  it('refuses anything else, and knows the zero address', () => {
    for (const bad of [
      '0x123',
      `0x${'g'.repeat(40)}`,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ]) {
      expect(normalizeAddress(BASE, bad)).toBeUndefined();
    }
    expect(isBurnAddress(BASE, `0x${'0'.repeat(40)}`)).toBe(true);
  });
});

describe('Solana addresses', () => {
  it('accepts a base58 key of 32 bytes, case preserved and compared exactly', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(normalizeAddress(SOLANA, mint)).toBe(mint);
    expect(sameAddress(SOLANA, mint, mint.toLowerCase())).toBe(false);
  });

  it('refuses characters outside base58 and keys of another length', () => {
    // 0, O, I and l are not in the alphabet
    expect(
      normalizeAddress(SOLANA, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt10'),
    ).toBeUndefined();
    // 31 zero bytes, then 44 characters worth 33 bytes
    expect(normalizeAddress(SOLANA, '1'.repeat(31))).toBeUndefined();
    expect(normalizeAddress(SOLANA, 'z'.repeat(44))).toBeUndefined();
  });

  it('treats the all-zero key as a burn address', () => {
    const zero = '1'.repeat(32);
    expect(normalizeAddress(SOLANA, zero)).toBe(zero);
    expect(isBurnAddress(SOLANA, zero)).toBe(true);
  });
});

describe('NEAR account IDs', () => {
  // Examples from the NEAR protocol specification's account ID rules
  it('accepts named accounts, subaccounts and implicit accounts', () => {
    for (const id of [
      'ok',
      'bowen',
      'ek-2',
      'ek.near',
      'com',
      'google.com',
      'bowen.google.com',
      'near',
      'illia.cheap-accounts.near',
      'max_99.near',
      '100',
      'near2019',
      'over.9000',
      'a.bro',
      'bro.a',
      // An implicit account and an Ethereum-implicit account
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      '0x06012c8cf97bead5deae237070f9587f8e7a266d',
      'a'.repeat(64),
    ]) {
      expect(normalizeAddress(NEAR, id), id).toBe(id);
    }
  });

  it('refuses IDs that break the rule, whatever their suffix', () => {
    for (const id of [
      'a',
      'A',
      'Abc',
      '-near',
      'near-',
      '-near-',
      'near.',
      '.near',
      'near..near',
      'near_-near',
      'near-_near',
      'near__near',
      'a b',
      'alice.near!',
      'a'.repeat(65),
    ]) {
      expect(normalizeAddress(NEAR, id), id).toBeUndefined();
    }
  });

  it('compares account IDs exactly and has no zero account', () => {
    expect(sameAddress(NEAR, 'alice.near', 'alice.near')).toBe(true);
    expect(isBurnAddress(NEAR, 'system')).toBe(false);
  });
});

describe('transaction references', () => {
  it('reads each family in its own form', () => {
    const near = 'FGgDFXFA3UCj533aWRMtV6iL3kVzLmgJKNt22HK9A7Z5';
    expect(isTransactionReference(NEAR, near)).toBe(true);
    // A Solana signature is 64 bytes, not a 32-byte NEAR hash
    expect(
      isTransactionReference(
        NEAR,
        '61HQAvrUL3kcNhYW9nYLGYvVbY7fREZaNvpvTyoMEpEHXcMS2i4pF8ThAGH8QNHHvhUMor8GEffUdHLSp4qQJd83',
      ),
    ).toBe(false);
    expect(isTransactionReference(NEAR, '')).toBe(false);
    expect(isTransactionReference(BASE, `0x${'ab'.repeat(32)}`)).toBe(true);
    expect(isTransactionReference(BASE, near)).toBe(false);
  });
});
