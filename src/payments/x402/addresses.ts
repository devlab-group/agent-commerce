/**
 * SDK-free address checks for config load and the CLI. EVM addresses compare
 * without case; Solana keys and NEAR account IDs compare exactly.
 */
import type { X402Network } from './networks';

// `0x` + 40 hex characters. Config load cannot check the EIP-55 checksum,
// which needs keccak-256; the x402 and MPP providers refuse a mixed-case
// address whose checksum is wrong when they start.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_ZERO = /^0x0{40}$/i;

/** `0x` followed by 40 hex characters, in any case */
export const isEvmAddress = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && EVM_ADDRESS.test(value);

/** The EVM zero address, in any case */
export const isEvmZeroAddress = (value: string): boolean => EVM_ZERO.test(value);

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A 32-byte key is 32 to 44 base58 characters
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// The all-zero key, which is the System Program and owns nothing recoverable
const SOLANA_ZERO = '11111111111111111111111111111111';
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
// A 64-byte Ed25519 signature is at most 88 base58 characters
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

// nearcore's account ID rule: 2 to 64 characters, lowercase alphanumeric runs
// joined by single "-", "_" or "."; implicit accounts are 64 hex characters
const NEAR_ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
// A transaction hash: 32 bytes in base58
const NEAR_TRANSACTION_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Returns the family's wire address or `undefined`. NEAR uses named or
 * implicit account IDs; a `.near` suffix does not identify the network.
 */
export function normalizeAddress(network: X402Network, value: string): string | undefined {
  switch (network.family) {
    case 'evm':
      return isEvmAddress(value) ? value : undefined;
    case 'svm':
      return SOLANA_ADDRESS.test(value) && base58ByteLength(value) === 32 ? value : undefined;
    case 'near':
      return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT_ID.test(value)
        ? value
        : undefined;
  }
}

/**
 * An address funds cannot be recovered from: the zero address of its family.
 * NEAR has no zero account.
 */
export function isBurnAddress(network: X402Network, wireAddress: string): boolean {
  switch (network.family) {
    case 'evm':
      return isEvmZeroAddress(wireAddress);
    case 'svm':
      return wireAddress === SOLANA_ZERO;
    case 'near':
      return false;
  }
}

/** Compare EVM addresses case-insensitively, Solana keys and NEAR account IDs exactly */
export function sameAddress(network: X402Network, a: string, b: string): boolean {
  return network.family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * A settlement reference in its family's form: an EVM transaction hash, a
 * Solana transaction signature or a NEAR transaction hash
 */
export function isTransactionReference(network: X402Network, value: string): boolean {
  switch (network.family) {
    case 'evm':
      return EVM_TRANSACTION_HASH.test(value);
    case 'svm':
      return SOLANA_SIGNATURE.test(value) && base58ByteLength(value) === 64;
    case 'near':
      return NEAR_TRANSACTION_HASH.test(value) && base58ByteLength(value) === 32;
  }
}

function base58ByteLength(value: string): number {
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(BASE58_ALPHABET.indexOf(char));
  // Each leading '1' encodes one leading zero byte
  const leadingZeros = value.length - value.replace(/^1+/, '').length;
  return leadingZeros + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2));
}
