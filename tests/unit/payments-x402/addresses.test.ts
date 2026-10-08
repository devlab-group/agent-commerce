// Address checks per family, with @ton/core and the x402 SDK as oracles for TON
import { Address } from '@ton/core';
import { normalizeTonAddress } from '@x402/tvm';
import { describe, expect, it } from 'vitest';
import { isBurnAddress, normalizeAddress, sameAddress } from '../../../src/payments/x402/addresses';
import { requireX402Network } from '../../../src/payments/x402/networks';

const BASE = requireX402Network('eip155:8453', 'test');
const SOLANA = requireX402Network('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'test');
const TON = requireX402Network('tvm:-239', 'test');
const TON_TESTNET = requireX402Network('tvm:-3', 'test');

const USDT_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

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

describe('TON addresses', () => {
  const parsed = Address.parse(USDT_RAW);

  it('reads every user-friendly form as the raw address the SDK uses', () => {
    for (const bounceable of [true, false]) {
      for (const urlSafe of [true, false]) {
        const friendly = parsed.toString({ bounceable, urlSafe });
        expect(normalizeAddress(TON, friendly)).toBe(USDT_RAW);
        expect(normalizeTonAddress(friendly)).toBe(USDT_RAW);
      }
    }
    expect(normalizeAddress(TON, USDT_RAW.toUpperCase())).toBe(USDT_RAW);
  });

  it('refuses a broken checksum', () => {
    const friendly = parsed.toString();
    const flipped = `${friendly.slice(0, 10)}${friendly[10] === 'A' ? 'B' : 'A'}${friendly.slice(11)}`;
    expect(normalizeAddress(TON, flipped)).toBeUndefined();
  });

  it('refuses a testnet-only address on mainnet and accepts it on testnet', () => {
    const testOnly = parsed.toString({ testOnly: true });
    expect(normalizeAddress(TON, testOnly)).toBeUndefined();
    expect(normalizeAddress(TON_TESTNET, testOnly)).toBe(USDT_RAW);
  });

  it('treats a zero account hash as a burn address', () => {
    expect(isBurnAddress(TON, `0:${'0'.repeat(64)}`)).toBe(true);
    expect(isBurnAddress(TON, USDT_RAW)).toBe(false);
  });
});
